import * as vscode from 'vscode';
import { IPredictionController, ILogger } from '../context/contracts';

export class PredictionController implements vscode.Disposable, IPredictionController {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
    outline: '1px dashed var(--vscode-textLink-activeForeground)',
  });
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly logger: ILogger) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => this.clearForDocument(event.document)),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.clearForDocument(editor.document);
        }
      }),
    );
  }

  dispose(): void {
    this.decoration.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  async handleSuggestionAccepted(_editor: vscode.TextEditor): Promise<void> {
    // No-op in BYOK mode — cursor prediction is local-only for now
  }

  clearForDocument(document: vscode.TextDocument): void {
    const editors = vscode.window.visibleTextEditors.filter((e) => e.document === document);
    for (const editor of editors) {
      editor.setDecorations(this.decoration, []);
    }
  }

  showPredictionAt(editor: vscode.TextEditor, line: number): void {
    if (line < 0 || line >= editor.document.lineCount) {return;}
    const range = editor.document.lineAt(line).range;
    editor.setDecorations(this.decoration, [range]);
  }
}
