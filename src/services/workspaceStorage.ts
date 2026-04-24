import * as vscode from 'vscode';
import { generateRandomIdSuffix } from '../utils/contentProcessor';

const WORKSPACE_STORAGE_KEYS = {
  UNIQUE_WORKSPACE_ID: 'uniqueWorkspaceId',
} as const;

export class WorkspaceStorage implements vscode.Disposable {
  private readonly workspaceState: vscode.Memento;
  private readonly globalState: vscode.Memento;
  private cachedWorkspaceId: string | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.workspaceState = context.workspaceState;
    this.globalState = context.globalState;
  }

  getWorkspaceId(): string {
    if (this.cachedWorkspaceId) {
      return this.cachedWorkspaceId;
    }

    let workspaceId = this.workspaceState.get<string>(WORKSPACE_STORAGE_KEYS.UNIQUE_WORKSPACE_ID);

    if (!workspaceId) {
      workspaceId = generateRandomIdSuffix();
      this.workspaceState.update(WORKSPACE_STORAGE_KEYS.UNIQUE_WORKSPACE_ID, workspaceId);
    }

    this.cachedWorkspaceId = `${workspaceId}-v1`;
    return this.cachedWorkspaceId;
  }

  clearCache(): void {
    this.cachedWorkspaceId = null;
  }

  dispose(): void {
    this.clearCache();
  }
}
