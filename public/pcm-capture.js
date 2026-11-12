// Capture mono audio, resample continuously to 16 kHz, and emit 32 ms PCM16 frames.
class PcmCapture extends AudioWorkletProcessor {
  constructor(){super();this.ratio=sampleRate/16000;this.weight=0;this.sum=0;this.frame=new Int16Array(512);this.offset=0;}
  process(inputs,outputs){
    // Silence this node's output so microphone audio is never played back locally.
    for(const output of outputs)for(const channel of output)channel.fill(0);
    const input=inputs[0]?.[0];if(!input)return true;
    for(const value of input){
      let remaining=1;
      while(remaining>1e-9){
        const used=Math.min(remaining,this.ratio-this.weight);this.sum+=value*used;this.weight+=used;remaining-=used;
        if(this.weight>=this.ratio-1e-9){
          const sample=Math.max(-1,Math.min(1,this.sum/this.ratio));this.frame[this.offset++]=Math.round(sample*(sample<0?32768:32767));this.weight=0;this.sum=0;
          if(this.offset===this.frame.length){this.port.postMessage(this.frame.buffer,[this.frame.buffer]);this.frame=new Int16Array(512);this.offset=0;}
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture',PcmCapture);
