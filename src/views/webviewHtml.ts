import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions & vscode.WebviewPanelOptions {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
  };
}

/** HTML for the history webview; `mode` selects the full Git Repository window or a single file's history. */
export function webviewHtml(extensionUri: vscode.Uri, webview: vscode.Webview, mode: 'repository' | 'file', title: string): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const dist = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', f));
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${dist('codicons/codicon.css')}">
<link rel="stylesheet" href="${dist('webview.css')}">
<title>${esc(title)}</title>
</head>
<body data-mode="${mode}" data-vscode-context='{"preventDefaultContextMenuItems": true}'>
<div id="app"></div>
<script nonce="${nonce}" src="${dist('webview.js')}"></script>
</body>
</html>`;
}
