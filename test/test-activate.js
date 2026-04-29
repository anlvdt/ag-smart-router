// Test activation of the installed extension with mocked vscode
'use strict';
const path = require('path');
const extPath = '/Users/anle/.antigravity/extensions/anlvdt.grav-4.0.2';

const mockDisposable = { dispose(){} };
const mockSubs = [];

const vscode = {
    env: { appName: 'Antigravity', appRoot: '/Applications/Antigravity.app/Contents/Resources/app' },
    window: {
        createStatusBarItem: (a,p) => {
            console.log('[OK] createStatusBarItem called');
            return { show(){ console.log('[OK] statusBar.show()'); }, dispose(){}, text:'', color:'', tooltip:'', command:'', backgroundColor:undefined };
        },
        showQuickPick: async()=>null,
        showInformationMessage: async()=>null,
        showWarningMessage: async()=>null,
        showErrorMessage: async(...a)=>{ console.log('[ERROR MSG]', a[0]); return null; },
        showInputBox: async()=>null,
        setStatusBarMessage:()=>{},
        terminals: [],
        onDidChangeTextEditorSelection: ()=>mockDisposable,
        onDidOpenTerminal: (fn)=>mockDisposable,
        onDidCloseTerminal: (fn)=>mockDisposable,
    },
    workspace: {
        getConfiguration: () => ({ get:(k,d)=>d, update:async()=>{} }),
        workspaceFolders: [{uri:{fsPath:'/tmp/test'},name:'test'}],
        onDidChangeConfiguration: ()=>mockDisposable,
        onDidChangeTextDocument: ()=>mockDisposable,
        createFileSystemWatcher: ()=>({onDidChange(){return mockDisposable},onDidCreate(){return mockDisposable},onDidDelete(){return mockDisposable},dispose(){}}),
    },
    commands: {
        getCommands: async()=>['antigravity.accept','antigravity.acceptAll'],
        executeCommand: async()=>{},
        registerCommand: (id,fn)=>mockDisposable,
    },
    StatusBarAlignment: { Right: 2, Left: 1 },
    ThemeColor: class ThemeColor{constructor(v){this.v=v}},
    ConfigurationTarget: { Global: 1, Workspace: 2 },
    RelativePattern: class RelativePattern{constructor(a,b){}},
    Uri: { file: (p)=>({fsPath:p}) },
};

// Inject mock
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent) {
    if (request === 'vscode') return 'vscode';
    return origResolve.apply(this, arguments);
};
require.cache['vscode'] = { id:'vscode', filename:'vscode', loaded:true, exports: vscode };

// Load and activate
try {
    const ext = require(path.join(extPath, 'src/extension.js'));
    console.log('[OK] Module loaded');
    const ctx = {
        globalState: { get:(k,d)=>d, update:async()=>{} },
        subscriptions: mockSubs,
        extension: { packageJSON: { version: '4.0.2' } }
    };
    ext.activate(ctx).then(() => {
        console.log('[OK] ACTIVATE SUCCESS - subscriptions:', mockSubs.length);
        process.exit(0);
    }).catch(e => {
        console.log('[FAIL] ACTIVATE ERROR:', e.message);
        console.log(e.stack.split('\n').slice(0,5).join('\n'));
        process.exit(1);
    });
} catch(e) {
    console.log('[FAIL] REQUIRE ERROR:', e.message);
    console.log(e.stack.split('\n').slice(0,5).join('\n'));
    process.exit(1);
}
