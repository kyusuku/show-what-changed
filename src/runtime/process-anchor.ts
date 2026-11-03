export const PROCESS_ANCHOR = `
const {spawn}=require('node:child_process');
const [input,...argv]=process.argv.slice(1);
let stopping=false;
process.on('SIGTERM',()=>{});
process.on('message',message=>{if(message?.kind==='release')process.exit(0)});
process.on('disconnect',()=>{if(stopping)return;stopping=true;try{process.kill(-process.pid,'SIGTERM')}catch{}setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL')}catch{}},3000)});
const child=spawn(argv[0],argv.slice(1),{shell:false,detached:false,stdio:[input==='pipe'?'pipe':'ignore','pipe','pipe']});
let spawnError=null;
child.on('error',()=>{spawnError='Process could not be started.'});
child.stdout.pipe(process.stdout,{end:false});
child.stderr.pipe(process.stderr,{end:false});
process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
if(child.stdin){child.stdin.on('error',()=>{});process.stdin.pipe(child.stdin)}
child.on('exit',(code,signal)=>{if(process.connected)process.send({kind:'exit',code,signal,spawnError})});
child.on('close',(code,signal)=>{process.stdout.end();process.stderr.end();if(process.connected)process.send({kind:'closed',code,signal,spawnError})});
`;
