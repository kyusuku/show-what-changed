import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const root = new URL('../../src/', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && specifier.endsWith('.js'))
    return next(new URL(specifier.slice(0, -3) + '.ts', context.parentURL).href, context);
  return next(specifier, context);
}});
const { sanitizeFrame } = await import(root + 'recorder/capture-png.ts');
assert.match(process.version, /^v24\./);
const signature=Buffer.from([137,80,78,71,13,10,26,10]);
function chunk(type,data=Buffer.alloc(0)){
  const out=Buffer.allocUnsafeSlow(data.length+12);out.writeUInt32BE(data.length);out.write(type,4,4);data.copy(out,8);
  out.writeUInt32BE(crc32(out.subarray(4,-4)),out.length-4);return out;
}
function run(width,height,channels,transparent,wholeMask){
  const pixels=width*height,stride=width*channels+1;
  const rows=Buffer.allocUnsafeSlow(stride*height);let state=71937;
  for(let i=0;i<rows.length;i++){state^=state<<13;state^=state>>>17;state^=state<<5;rows[i]=state;}
  for(let y=0;y<height;y++)rows[y*stride]=0;
  const compressed=deflateSync(rows,{level:1});
  const exact=inflateSync(compressed,{info:true,maxOutputLength:rows.length,chunkSize:Math.max(64,rows.length+1)});
  assert.equal(exact.buffer.buffer.byteLength,rows.length+1);
  assert.equal(exact.engine.bytesWritten,compressed.length);
  let outputRows=exact.buffer;
  if(transparent){
    outputRows=Buffer.allocUnsafeSlow((4*width+1)*height);
    for(let y=0;y<height;y++){
      outputRows[y*(4*width+1)]=0;
      for(let x=0;x<width;x++){
        const s=y*stride+1+x*3,t=y*(4*width+1)+1+x*4;
        outputRows[t]=rows[s];outputRows[t+1]=rows[s+1];outputRows[t+2]=rows[s+2];outputRows[t+3]=255;
      }
    }
  }
  const outChannels=transparent?4:channels,outStride=outChannels*width+1;
  if(wholeMask)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const at=y*outStride+1+x*outChannels;outputRows[at]=outputRows[at+1]=outputRows[at+2]=16;
    if(outChannels===4)outputRows[at+3]=255;
  }
  const cap=5*pixels+256;
  const encoded=deflateSync(outputRows,{info:true,level:1,strategy:3,chunkSize:32768,maxOutputLength:cap});
  const C=encoded.buffer.length;
  assert(C<=cap);
  assert.equal(encoded.engine._outBuffer.buffer.byteLength,32768);
  assert.equal(encoded.buffer.buffer.byteLength,C<=32768?32768:C);
  const hdr=Buffer.alloc(13);hdr.writeUInt32BE(width);hdr.writeUInt32BE(height,4);hdr[8]=8;hdr[9]=channels===3?2:6;
  const source=Buffer.concat([signature,chunk('IHDR',hdr),...(transparent?[chunk('tRNS',Buffer.alloc(6))]:[]),chunk('IDAT',compressed),chunk('IEND')]);
  const safe=sanitizeFrame(source,{width,height},wholeMask?[{x:0,y:0,width,height}]:[]);
  assert.equal(safe.buffer.byteLength,safe.length);
  const transferred=Uint8Array.from(safe);
  assert.equal(transferred.buffer.byteLength,safe.length);
  const retainedRows=outputRows.buffer.byteLength;
  const encodeBound=retainedRows+2*C+32768+73;
  const worstBound=14*pixels+height+33354;
  assert(encodeBound<16*pixels);assert(worstBound<16*pixels);
  const expandBound=transparent?exact.buffer.buffer.byteLength+outputRows.buffer.byteLength:exact.buffer.buffer.byteLength;
  assert(expandBound<16*pixels);
  return {width,height,channels,transparent,wholeMask,sourceBytes:source.length,inflateBacking:exact.buffer.buffer.byteLength,
    retainedRows,compressedBytes:C,compressedBacking:encoded.buffer.buffer.byteLength,firstDeflateChunkBacking:encoded.engine._outBuffer.buffer.byteLength,
    outputBytes:safe.length,outputBacking:safe.buffer.byteLength,workerReplyBacking:transferred.buffer.byteLength,
    expandPayloadBound:expandBound,encodePayloadBound:encodeBound,worstPayloadBound:worstBound,processingAllowance:16*pixels};
}
const records=[];
for(const [w,h] of [[320,240],[1280,800],[1920,1080]])for(const [channels,trns] of [[3,false],[4,false],[3,true]])for(const mask of [false,true]){
 records.push(run(w,h,channels,trns,mask));global.gc?.();
}
const nodeSource=process.binding('natives').zlib;
const start=nodeSource.indexOf('function processChunkSync('),end=nodeSource.indexOf('\nfunction processChunk(',start);
const source=nodeSource.slice(start,end);
assert(source.includes('Buffer.allocUnsafe(chunkSize)'));
assert(source.includes('Buffer.concat(buffers, nread)'));
assert(source.indexOf('nread > self._maxOutputLength')<source.indexOf('Buffer.concat(buffers, nread)'));
console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,
 nodeSyncImplementationSha256:createHash('sha256').update(source).digest('hex'),records,
 interpretation:'Public native primitives use the exact production options. Source inspection bounds transient chunks and verifies over-cap throw before concatenation. Production sanitizer final backing and worker reply copy were measured directly. This is payload backing allocation evidence, not RSS, zlib workspace, GC timing, or a speed measurement.'},null,2));
