import * as vscode from 'vscode';

export let DbgChannel = vscode.window.createOutputChannel("Focus");

class AssertionError extends Error {
    msg?: string;
    constructor(msg?: string) {
        super(msg);
        this.msg = msg;
    }
}

export function assert(condition: any, msg?: string): asserts condition {
    if (!condition) {
      throw new AssertionError(msg);
    }
}
