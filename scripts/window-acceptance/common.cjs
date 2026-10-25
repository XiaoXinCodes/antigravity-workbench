const fs=require('node:fs/promises'),path=require('node:path');
async function configuration(root){
 if(!/\/AntigravityWindowTest-[a-f0-9-]{36}$/.test(root))throw Error('FIXTURE_ROOT_INVALID');
 const c=JSON.parse(await fs.readFile(path.join(root,'config.json'),'utf8'));
 if(!/^[a-f0-9-]{36}$/.test(c.id)||path.basename(root)!=='AntigravityWindowTest-'+c.id||!c.windowsRoot?.endsWith('\\AntigravityWindowTest-'+c.id)||!/^\w:\\/.test(c.windowsRoot)||/[\r\n\0]/.test(c.windowsRoot))throw Error('FIXTURE_CONFIG_INVALID');
 const workspace=new URL(c.workspaceUri),fixture=new URL(c.fixtureUri);if(workspace.protocol!=='vscode-remote:'||fixture.protocol!=='vscode-remote:'||workspace.host!==fixture.host||!/^wsl\+[a-zA-Z0-9._-]+$/.test(workspace.host)||decodeURIComponent(workspace.pathname)!==root+'/workspace'||decodeURIComponent(fixture.pathname)!==root+'/fixture'||workspace.search||workspace.hash||fixture.search||fixture.hash)throw Error('FIXTURE_URI_INVALID');
 return c;
}
function launcher(root,c){
 const {WslWindowLauncher,nativeWslLauncherIO}=require(path.join(root,'out/wsl-window-launcher.js'));
 return new WslWindowLauncher({...nativeWslLauncherIO,run:(exe,args,cwd,env,probe)=>{
  const isolated=probe?args:[args[0],'--user-data-dir',c.windowsRoot+'\\user-data','--extensions-dir',c.windowsRoot+'\\extensions','--extensionDevelopmentPath='+c.fixtureUri,'--disable-extensions',...args.slice(1)];
  return nativeWslLauncherIO.run(exe,isolated,cwd,env,probe);
 }},{...process.env,VSCODE_CLIENT_COMMAND:c.executable});
}
module.exports={configuration,launcher};
