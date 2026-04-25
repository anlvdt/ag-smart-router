const vscode = require('vscode');

async function testModelSwitch() {
    const cmds = await vscode.commands.getCommands(true);
    const modelCmds = cmds.filter(c => c.includes('model') || c.includes('Model'));
    console.log('Model-related commands:', modelCmds);
    
    try {
        await vscode.commands.executeCommand('workbench.action.chat.changeModel', {
            vendor: 'google',
            id: 'gemini-3.1-pro',
            family: 'gemini'
        });
        console.log('changeModel command executed!');
    } catch (e) {
        console.log('changeModel failed:', e.message);
    }
}

testModelSwitch();
