import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
for(const rate of [44100,48000])test(`capture resamples ${rate} Hz into 16 kHz PCM frames with silent monitoring`,()=>{
  let Processor;const frames=[];
  const context={sampleRate:rate,AudioWorkletProcessor:class{constructor(){this.port={postMessage:buffer=>frames.push(new Int16Array(buffer))};}},registerProcessor:(name,p)=>Processor=p};
  vm.runInNewContext(readFileSync(new URL('../public/pcm-capture.js',import.meta.url),'utf8'),context);
  const p=new Processor();
  for(let i=0;i<rate;i+=128){const input=new Float32Array(Math.min(128,rate-i)).fill(.5),output=new Float32Array(128).fill(1);p.process([[input]],[[output]]);assert(output.every(x=>x===0));}
  assert.equal(frames.length,31);assert.equal(frames[0].length,512);assert(frames.every(f=>f.every(x=>Math.abs(x-16383.5)<=.5)));
});
