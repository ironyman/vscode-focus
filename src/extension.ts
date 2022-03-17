/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';

import { DbgChannel, assert } from './debug';

enum SyntaxKind {
	Function = 11
}

// Prevent nested onDidChangeTextDocument handling.
let handlingChange = false;

// This class synchronizes content between full document from fullLineStart to fullLineEnd
// with focused document.
export class FocusDocumentBinding {
	full: vscode.TextEditor;
	fullLineStart: number;
	fullLineEnd: number;
	focused: vscode.TextEditor;

	constructor(full: vscode.TextEditor,
				fullLineStart: number,
				fullLineEnd: number,
				focused: vscode.TextEditor) {
		this.full = full;
		this.fullLineStart = fullLineStart;
		this.fullLineEnd = fullLineEnd;
		this.focused = focused;
	}
}

let bindings: Array<FocusDocumentBinding> = [];

export function findBindingDirection(uri: vscode.Uri): [FocusDocumentBinding, vscode.TextEditor, vscode.TextEditor] {
	let binding = bindings.find(b => b.full.document.uri == uri);
	let target = undefined, source = undefined;

	if (!binding) {
		binding = bindings.find(b => b.focused.document.uri == uri);

		if (!binding) {
			throw new Error("No binding found!");
		}

		source = binding.focused;
		target = binding.full;
	} else {
		source = binding.full;
		target = binding.focused;
	}

	return [binding, source, target];
}

class FocusCodeLensProvider implements vscode.CodeLensProvider {
	async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
		let res: Array<vscode.CodeLens> = [];
		const symbols: Array<vscode.SymbolInformation> = await vscode.commands.executeCommand(
			'vscode.executeDocumentSymbolProvider', document.uri);

		for (let s of symbols) {
			if (s.kind != vscode.SymbolKind.Function) {
				continue;
			}
			
			let c: vscode.Command = {
				command: 'focus.onFunction',
				title: 'Split view function',
				arguments: [s.name, s.location.range.start.line, s.location.range.end.line]
			}
			let codeLens = new vscode.CodeLens(s.location.range, c)
	
			res.push(codeLens);
		}

		return res;
	}
}

async function FocusOnLinesInSplitWindow(editor: vscode.TextEditor, fullLineStart: number, fullLineEnd: number) {
	const tempDir = os.tmpdir();
	const ext = path.extname(editor.document.fileName);
	const tempFileName = path.join(tempDir, uuidv4() + '.' + ext);

	const focusedFileUri = vscode.Uri.file(tempFileName).with({ scheme: 'untitled' });
	const focusedDoc = await vscode.workspace.openTextDocument(focusedFileUri);

	// Fill in initial content
	const edit = new vscode.WorkspaceEdit();
	const fullText = editor.document.getText();

	const fullLineStartOffset = editor.document.offsetAt(editor.document.lineAt(fullLineStart).range.start);
	const fullLineEndOffset = editor.document.offsetAt(editor.document.lineAt(fullLineEnd).range.end);

	edit.insert(focusedFileUri, new vscode.Position(0, 0), fullText.substring(fullLineStartOffset, fullLineEndOffset));

	await vscode.workspace.applyEdit(edit);

	// Actually show the editor
	// vscode.commands.executeCommand('vscode.open', focusedFileUri);
	let focusedEditor = await vscode.window.showTextDocument(focusedDoc, { 
		preview: false,
		viewColumn: vscode.ViewColumn.Beside
	});

	bindings.push(new FocusDocumentBinding(editor, 
		fullLineStart,
		fullLineEnd,
		focusedEditor));
}
  
export function activate(context: vscode.ExtensionContext) {
	
    if (process.env.VSCODE_DEBUG_MODE === "true") {
        DbgChannel.show();
    }

	// BUG: The first changes in full document has no event.contentChanges. Is it vscode bug?
	// BUG: C-z in focused document will delete everything in focused document as well as full document
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async (event: vscode.TextDocumentChangeEvent) => {
		if (handlingChange) {
			return;
		}

		let binding, source, target;
		try {
			[binding, source, target] = findBindingDirection(event.document.uri)
		} catch (e: any) {
			// Lots of noise.
			// DbgChannel.appendLine(e.message);
			return;
		}

		handlingChange = true;
		let edit = new vscode.WorkspaceEdit();

		for (let change of event.contentChanges) {
			DbgChannel.appendLine("Change event: " + JSON.stringify(change));

			let targetRange;

			if (target.document.uri == binding.full.document.uri) {
				targetRange = new vscode.Range(
					change.range.start.line + binding.fullLineStart,
					change.range.start.character,
					change.range.end.line + binding.fullLineStart,
					change.range.end.character);
			} else {
				assert(target.document.uri == binding.focused.document.uri)
				targetRange = new vscode.Range(
					change.range.start.line - binding.fullLineStart,
					change.range.start.character,
					change.range.end.line - binding.fullLineStart,
					change.range.end.character);	
			}

			if (change.text.length == 0) {
				// Length of text of 0 means deletion
				edit.delete(target.document.uri, targetRange);
			} else if (change.rangeLength == 0) {
				// Range length of 0 means nothing was replaced.
				edit.insert(target.document.uri, targetRange.start, change.text);
			} else {
				edit.replace(target.document.uri, targetRange, change.text);
			}
		}

		await vscode.workspace.applyEdit(edit);
		handlingChange = false;

		// This api doesn't work/
		// target.edit((editBuilder: vscode.TextEditorEdit) => {
		// 	for (let change of event.contentChanges) {
		// 		DbgChannel.appendLine("Change event: " + JSON.stringify(change));
		// 		if (change.text.length == 0) {
		// 			// Length of text of 0 means deletion
		// 			editBuilder.delete(change.range);
		// 		} else if (change.rangeLength == 0) {
		// 			// Length of text of 0 means deletion

		// 		}

		// 	}
		// })
	}));

	context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(async (doc: vscode.TextDocument) => {
		let binding, source, target;
		try {
			[binding, source, target] = findBindingDirection(doc.uri)
		} catch (e: any) {
			// Lots of noise.
			// DbgChannel.appendLine(e.message);
			return;
		}

		if (doc.uri == binding.full.document.uri) {
			await vscode.window.showTextDocument(target.document.uri, {preview: true, preserveFocus: false});
			vscode.commands.executeCommand('workbench.action.closeActiveEditor');
		} else {
			assert(doc.uri == target.document.uri);
		}

		let index = bindings.indexOf(binding);
		bindings.splice(index, 1);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('focus.onSelection', async () => {
		let activeTextEditor = vscode.window.activeTextEditor;
		if (!activeTextEditor 
			|| activeTextEditor.selections.length != 1
			|| activeTextEditor.selection.start == activeTextEditor.selection.end) {
			return;
		}

		FocusOnLinesInSplitWindow(activeTextEditor, activeTextEditor.selection.start.line, activeTextEditor.selection.end.line);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('focus.onFunction', async (functionName, fullLineStart, fullLineEnd) => {
		let activeTextEditor = vscode.window.activeTextEditor;
		if (!activeTextEditor) {
			return;
		}
        
		FocusOnLinesInSplitWindow(activeTextEditor, fullLineStart, fullLineEnd);
	}));

	const languages = ["javascript", "typescript", "c", "c++"];
	for (let l of languages) {
		context.subscriptions.push(vscode.languages.registerCodeLensProvider(
			l,
			new FocusCodeLensProvider()
		));
	}
}
