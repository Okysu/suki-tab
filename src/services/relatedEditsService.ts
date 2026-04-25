import * as vscode from 'vscode';
import { ILogger, IRelatedEditsService } from '../context/contracts';

interface RelatedEditFilePickItem extends vscode.QuickPickItem {
  readonly uri: vscode.Uri;
  readonly locations: readonly vscode.Location[];
}

export class RelatedEditsService implements vscode.Disposable, IRelatedEditsService {
  constructor(private readonly logger: ILogger) {}

  dispose(): void {}

  async reviewRelatedEdits(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): Promise<void> {
    if (!editor) {
      void vscode.window.showWarningMessage('SukiTab: Open an editor to review related edits.');
      return;
    }

    const symbolRange = editor.document.getWordRangeAtPosition(editor.selection.active);
    if (!symbolRange) {
      void vscode.window.showWarningMessage('SukiTab: Place the cursor on a symbol to review related edits.');
      return;
    }

    const symbolText = editor.document.getText(symbolRange);
    if (!symbolText.trim()) {
      void vscode.window.showWarningMessage('SukiTab: Could not determine the current symbol.');
      return;
    }

    const references = await this.findMatchingReferences(editor.document, editor.selection.active, symbolRange, symbolText);
    if (references.length === 0) {
      void vscode.window.showInformationMessage(`SukiTab: No related references found for "${symbolText}".`);
      return;
    }

    const selectedFiles = await this.pickFilesForReview(references, editor.document.uri, symbolText);
    if (!selectedFiles) {
      return;
    }
    if (selectedFiles.length === 0) {
      void vscode.window.showInformationMessage('SukiTab: No files selected. No edits were applied.');
      return;
    }

    const replacement = await this.promptForReplacement(symbolText, selectedFiles.length);
    if (replacement === undefined) {
      return;
    }
    if (replacement === symbolText) {
      void vscode.window.showInformationMessage('SukiTab: Replacement matches the current symbol. No edits were applied.');
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    let totalEdits = 0;

    for (const item of selectedFiles) {
      const sortedLocations = [...item.locations].sort((left, right) => this.compareLocationsDescending(left, right));
      for (const location of sortedLocations) {
        edit.replace(location.uri, location.range, replacement);
        totalEdits += 1;
      }
    }

    if (totalEdits === 0) {
      void vscode.window.showInformationMessage('SukiTab: No matching edits were prepared.');
      return;
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      this.logger.warn('[RelatedEdits] WorkspaceEdit was rejected by VS Code.');
      void vscode.window.showErrorMessage('SukiTab: Failed to apply related edits.');
      return;
    }

    this.logger.info(
      `[RelatedEdits] Applied ${totalEdits} edit(s) for "${symbolText}" across ${selectedFiles.length} file(s)`
    );
    void vscode.window.showInformationMessage(
      `SukiTab: Applied ${totalEdits} related edit(s) across ${selectedFiles.length} file(s).`
    );
  }

  private async findMatchingReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    symbolRange: vscode.Range,
    symbolText: string,
  ): Promise<vscode.Location[]> {
    let references: vscode.Location[] | undefined;

    try {
      references = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        document.uri,
        position,
      );
    } catch (error) {
      this.logger.error('[RelatedEdits] Failed to resolve references', error);
      void vscode.window.showErrorMessage('SukiTab: Unable to query language references for the current symbol.');
      return [];
    }

    const documentCache = new Map<string, vscode.TextDocument>([[document.uri.toString(), document]]);
    const uniqueLocations = new Map<string, vscode.Location>();

    for (const location of [...(references ?? []), new vscode.Location(document.uri, symbolRange)]) {
      if (!(await this.locationMatchesSymbol(location, symbolText, documentCache))) {
        continue;
      }

      uniqueLocations.set(this.getLocationKey(location), location);
    }

    return [...uniqueLocations.values()].sort((left, right) => this.compareLocationsAscending(left, right));
  }

  private async locationMatchesSymbol(
    location: vscode.Location,
    symbolText: string,
    documentCache: Map<string, vscode.TextDocument>,
  ): Promise<boolean> {
    const targetDocument = await this.getDocument(location.uri, documentCache);
    if (!targetDocument) {
      return false;
    }

    const locatedText = targetDocument.getText(location.range);
    if (locatedText !== symbolText) {
      this.logger.info(
        `[RelatedEdits] Skipping non-matching reference at ${this.getLocationKey(location)} (found "${locatedText}")`
      );
      return false;
    }

    return true;
  }

  private async getDocument(
    uri: vscode.Uri,
    documentCache: Map<string, vscode.TextDocument>,
  ): Promise<vscode.TextDocument | undefined> {
    const key = uri.toString();
    const cached = documentCache.get(key);
    if (cached) {
      return cached;
    }

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      documentCache.set(key, document);
      return document;
    } catch (error) {
      this.logger.warn(`[RelatedEdits] Could not open ${uri.toString()}: ${String(error)}`);
      return undefined;
    }
  }

  private async pickFilesForReview(
    references: readonly vscode.Location[],
    activeUri: vscode.Uri,
    symbolText: string,
  ): Promise<readonly RelatedEditFilePickItem[] | undefined> {
    const items = await this.buildQuickPickItems(references, activeUri);
    if (items.length === 0) {
      return [];
    }

    return vscode.window.showQuickPick(items, {
      canPickMany: true,
      ignoreFocusOut: true,
      title: 'SukiTab: Review Related Edits',
      placeHolder: `Select files containing references to "${symbolText}"`,
    });
  }

  private async buildQuickPickItems(
    references: readonly vscode.Location[],
    activeUri: vscode.Uri,
  ): Promise<RelatedEditFilePickItem[]> {
    const groupedLocations = new Map<string, { uri: vscode.Uri; locations: vscode.Location[] }>();

    for (const location of references) {
      const key = location.uri.toString();
      const existing = groupedLocations.get(key);
      if (existing) {
        existing.locations.push(location);
      } else {
        groupedLocations.set(key, {
          uri: location.uri,
          locations: [location],
        });
      }
    }

    const items = await Promise.all(
      [...groupedLocations.values()]
        .sort((left, right) => this.getFileLabel(left.uri).localeCompare(this.getFileLabel(right.uri)))
        .map(async ({ uri, locations }) => {
          const firstLocation = locations[0];
          const preview = await this.getLocationPreview(firstLocation);
          const isCurrentFile = uri.toString() === activeUri.toString();

          return {
            label: this.getFileLabel(uri),
            description: `${locations.length} reference(s)${isCurrentFile ? ' • current file' : ''}`,
            detail: preview,
            uri,
            locations: locations.sort((left, right) => this.compareLocationsAscending(left, right)),
          } satisfies RelatedEditFilePickItem;
        })
    );

    return items;
  }

  private async getLocationPreview(location: vscode.Location): Promise<string | undefined> {
    const document = await this.getDocument(location.uri, new Map());
    if (!document) {
      return undefined;
    }

    try {
      const lineText = document.lineAt(location.range.start.line).text.trim();
      if (!lineText) {
        return undefined;
      }

      return this.truncate(lineText, 120);
    } catch {
      return undefined;
    }
  }

  private async promptForReplacement(symbolText: string, fileCount: number): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: 'SukiTab: Review Related Edits',
      prompt: `Replace "${symbolText}" in ${fileCount} selected file(s)`,
      placeHolder: 'Enter the replacement text',
      value: symbolText,
      valueSelection: [0, symbolText.length],
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (value.trim().length === 0) {
          return 'Replacement cannot be empty.';
        }
        if (/\r|\n/.test(value)) {
          return 'Replacement must stay on a single line.';
        }
        return undefined;
      },
    });
  }

  private getFileLabel(uri: vscode.Uri): string {
    const relativePath = vscode.workspace.asRelativePath(uri, false);
    return relativePath || uri.fsPath || uri.toString();
  }

  private getLocationKey(location: vscode.Location): string {
    const { start, end } = location.range;
    return `${location.uri.toString()}:${start.line}:${start.character}-${end.line}:${end.character}`;
  }

  private compareLocationsAscending(left: vscode.Location, right: vscode.Location): number {
    const leftUri = left.uri.toString();
    const rightUri = right.uri.toString();
    if (leftUri !== rightUri) {
      return leftUri.localeCompare(rightUri);
    }

    if (left.range.start.line !== right.range.start.line) {
      return left.range.start.line - right.range.start.line;
    }

    return left.range.start.character - right.range.start.character;
  }

  private compareLocationsDescending(left: vscode.Location, right: vscode.Location): number {
    return this.compareLocationsAscending(right, left);
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength - 1)}…`;
  }
}
