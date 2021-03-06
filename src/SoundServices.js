import Meyda from 'meyda'

export default class SoundServices {

  track = {
    _id: null,
    _rev: null,
    title: null,
    lyrics: null
  }
  baseTrack = {
    volume: null,
    buffer: null
  }
  micTrack = {
    volume: null,
    buffer: null
  }
  quietRMS;
  stream;
  mediaRecorder;
  recordedBuffer;
  playSource;
  liveMixer;
  arr;
  audioCtx = new AudioContext();

  constructor() {
    return
  }

  getBufferFromRaw(arrayBuffer) {
    const array = new Float32Array(arrayBuffer);
    const buffer = this.audioCtx.createBuffer(1,array.length,48000);
    try {
      buffer.copyToChannel(array, 0);
    } catch {
      buffer.getChannelData(0).set(array); //safari
    }
    return buffer;
  }

  async getBufferFromEncoded(arrayBuffer) {
    var buffer;
    try {
      buffer = await this.audioCtx.decodeAudioData(arrayBuffer);
    } catch { // safari
      buffer = await new Promise((resolve, reject) => {
        this.audioCtx.decodeAudioData(arrayBuffer, (d) => resolve(d), (e) => reject(e));
      });
    }
    return buffer;
  }

  async fetchArrayBuffer(url) {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    return arrayBuffer;
  }

  async fetchBaseAudio(id) {
    const arrayBuffer = await this.fetchArrayBuffer('hotpotato/' + id);
    this.baseTrack.buffer = this.getBufferFromRaw(arrayBuffer);
    this.baseTrack.volume = this.getVolume(this.baseTrack.buffer.getChannelData(0));
  }

  async setBaseAudio(file) {
    var arrayBuffer;
    try {
      arrayBuffer = await file.arrayBuffer();
    } catch {
      arrayBuffer = await new Response(file).arrayBuffer();
    }
    this.baseTrack.buffer = await this.getBufferFromEncoded(arrayBuffer);
    this.baseTrack.volume = this.getVolume(this.baseTrack.buffer.getChannelData(0));
  }

  async fetchMeta(id) {
    const response = await fetch('hotpotato-meta/' + id);
    const meta = await response.json();
    this.track.title = meta.title;
    this.track.lyrics = meta.lyrics;
    this.track._id = meta._id;
    this.track._rev = meta._rev;
  }

  getVolume(pcmArray) {
    return Math.sqrt(pcmArray.reduce((s,v)=> s + v*v)/pcmArray.length);
  }

  getGain(linear1, linear2) {
    return linear2/linear1;
  }

  bufferToSource(buffer, loop) {
    let source = this.audioCtx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    return source;
  }

  playBuffer(buffer, loop) {
    const source = this.bufferToSource(buffer, loop);
    source.connect(this.audioCtx.destination);
    source.start();
    return () => {
      source.disconnect();
      source.stop();
    }
  }

  playBaseAudio() {
    return this.playBuffer(this.baseTrack.buffer, true);
  }

  async requestMic() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
      autoGainControl: false,
      echoCancellation: false,
      channelCount: 1,
      latency: 0
    }, video: false })
    return this.stream;
  }

  async listen() {
    const listenCtx = new AudioContext();
    listenCtx.resume();
    const streamSource = listenCtx.createMediaStreamSource(this.stream.clone());
    var heardResolver;
    var heardPromise = new Promise((resolve) => heardResolver = resolve);
    var rmss = [];
    var sfs = [];
    const analyzer = Meyda.createMeydaAnalyzer({
      "audioContext": listenCtx,
      "source": streamSource,
      "channel": 0,
      "bufferSize": 16384,
      "featureExtractors": ["spectralFlatness", "rms"],
      "callback": features => {
        if(features.rms != 0) {
          rmss.push(features.rms);
          sfs.push(features.spectralFlatness);
        }
        if( rmss.length > 4 ) {
          const baseline = (( rmss[2] + rmss[3] ) / 2) / (( sfs[2] + sfs[3] ) / 2);
          const current = features.rms / features.spectralFlatness;
          if( baseline*3 < current ) {
            fetch('log', {method: 'post', body: "heard SF "+features.spectralFlatness });
            heardResolver();
          }
        } 
      }
    });
    analyzer.start();
    await heardPromise;
    rmss.pop(); rmss.pop();
    this.quietRMS = Math.sqrt(rmss.reduce((s,v)=> s + v*v)/rmss.length);
    analyzer.stop();
    streamSource.disconnect();
    streamSource.mediaStream.getAudioTracks()[0].stop();
    listenCtx.close();
  }

  async record() {
    const merger = this.audioCtx.createChannelMerger(2);
    const mixedStream = this.audioCtx.createMediaStreamDestination();
    
    const baseTrackSplitter = this.audioCtx.createChannelSplitter(1);
    const baseTrackSource = this.bufferToSource(this.baseTrack.buffer);
    baseTrackSource.connect(this.audioCtx.destination);
    baseTrackSource.connect(baseTrackSplitter);
    baseTrackSplitter.connect(merger,0,0)

    const micSplitter = this.audioCtx.createChannelSplitter(1);
    const micStream = this.audioCtx.createMediaStreamSource(this.stream);
    var gainNode = this.audioCtx.createGain();
    micStream.connect(gainNode);
    gainNode.connect(micSplitter);
    micSplitter.connect(merger, 0, 1);

    merger.connect(mixedStream);

    const recorder = new SafariAudioBufferRecorder(this.audioCtx, mixedStream.stream);

    var doneResolver;
    const donePromise = new Promise((resolve) => doneResolver = resolve);

    baseTrackSource.addEventListener('ended', () => {
      recorder.stop();
      baseTrackSource.disconnect();

      const buffer = recorder.output;
      this.micTrack.volume = this.getVolume(buffer.getChannelData(1));
      let gain = this.baseTrack.volume/this.micTrack.volume;
      if(this.micTrack.volume < this.quietRMS*2) gain = 1;
      this.liveMixer = new LiveMixer(buffer, gain, this.stream.getAudioTracks()[0].getSettings().latency || 0);

      doneResolver();
    });
    
    baseTrackSource.start();
    recorder.start();

    return donePromise;
  }

  async getRecordedBuffer(chunks) {
    const chunksBlob = new Blob(chunks);
    var arrayBuffer;
    try {
      arrayBuffer = await chunksBlob.arrayBuffer();
    } catch {
      arrayBuffer = await new Response(chunksBlob).arrayBuffer();
    }
    var recordedAudioBuffer;
    try {
      recordedAudioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
    } catch { // safari
      recordedAudioBuffer = await new Promise((resolve, reject) => {
        this.audioCtx.decodeAudioData(arrayBuffer, (d) => resolve(d), (e) => reject(e));
      });
    }
    return recordedAudioBuffer;
  }

  async resample(buffer, newRate) {
    const offlineAudioCtx = new OfflineAudioContext(buffer.numberOfChannels, newRate*buffer.duration, newRate);
    const source = offlineAudioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(offlineAudioCtx.destination);
    source.start(0);
    var render;
    render = await offlineAudioCtx.startRendering();
    if(!render) {
      render = await new Promise((resolve) => {
        offlineAudioCtx.startRendering();
        offlineAudioCtx.oncomplete = (e) => resolve(e.renderedBuffer);
      });
    }
    return render;
  }

  async mix(buffer2) {
    const offlineAudioCtx = new OfflineAudioContext(1, buffer2.duration*48000, 48000);
    const source = offlineAudioCtx.createBufferSource();
    source.buffer = buffer2;

    const splitter = offlineAudioCtx.createChannelSplitter(2);
    const merger = offlineAudioCtx.createChannelMerger(2);

    const delay = this.liveMixer.delay;
    const delayNode = offlineAudioCtx.createDelay(Math.max(delay,1));
    delayNode.delayTime.setValueAtTime(delay, 0);

    const gain = offlineAudioCtx.createGain();
    gain.gain.value = this.liveMixer.gainNode.gain.value

    source.connect(splitter);
    splitter.connect(delayNode, 0);
    splitter.connect(gain, 1);
    delayNode.connect(merger, 0, 0);
    gain.connect(merger, 0, 1);
    merger.connect(offlineAudioCtx.destination);
    source.start(0)

    var render = await offlineAudioCtx.startRendering();
    if(!render) {
      render = await new Promise((resolve) => {
        offlineAudioCtx.startRendering();
        offlineAudioCtx.oncomplete = (e) => resolve(e.renderedBuffer);
      });
    }
    return render;
  }

  playMixed(audioBuffer) {
    var mix = this.audioCtx.createBufferSource();
    mix.buffer = audioBuffer;
    mix.connect(this.audioCtx.destination);
    //this.setupMixedDownload(mix);
    mix.start();
  }

  setupMixedDownload(mixNode) {
    var stream = this.audioCtx.createMediaStreamDestination();
    var mediaRecorder = new MediaRecorder(stream.stream);
    mixNode.connect(stream);

    var chunks = [];
    mixNode.addEventListener('ended', () => {
      mediaRecorder.stop();
    })
    mediaRecorder.addEventListener('stop', async function() {
      try {
        var blob = new Blob(chunks, { 'type' : 'audio/ogg; codecs=opus' });
        var url = URL.createObjectURL(blob);
        console.log(url);
      } catch(e) {
        console.log(e);
      }
    });
    mediaRecorder.addEventListener('dataavailable', async function(e) { //assuming this event only happens after recording 
      if (e.data.size > 0) {
        chunks.push(e.data);
      }
    });
    mediaRecorder.start();
  }

  async saveMixed(audioBuffer) { //deprecated
    const mixRawData = audioBuffer.getChannelData(0);
    const mixDataBlob = new Blob([mixRawData]);
    return fetch('output', {method: 'post', body: mixDataBlob});
  }

  async saveBuffer(audioBuffer) {
    if(!audioBuffer) {
      audioBuffer = this.baseTrack.buffer;
    }
    if(!audioBuffer) {
      return;
    }
    var method = 'post';
    var url = 'hotpotato-track';
    if(this.track._id) {
      method = 'put';
      url += '/' + this.track._id + '/' + this.track._rev;
    }
    const rawData = audioBuffer.getChannelData(0);
    const dataBlob = new Blob([rawData]);
    const response = await fetch(url, {
      method: method,
      body: dataBlob,
      headers: { 'Content-Type': 'application/x-binary' }
    });
    const updated = await response.json();
    this.track._id = updated.id;
    this.track._rev = updated.rev;
    fetch('log', {method: 'post', body: updated.id });
  }

  async saveMeta() {
    const response = await fetch('hotpotato-meta', {
      method: 'put',
      body: JSON.stringify(this.track),
      headers: { 'Content-Type': 'application/json' }
    });
    const updated = await response.json();
    this.track._id = updated.id;
    this.track._rev = updated.rev;
  }
}

export class LiveMixer {
  delay;
  delayNode;
  gainNode;
  recordedNode;
  baseNode;
  ctx;
  killed;
  initialNode;

  constructor(recordedBuffer2, gain, micDelay) {
    this.killed = false;
    
    this.ctx = new AudioContext();    

    this.delay = 0.005 + (this.ctx.baseLatency || 0) + micDelay;
    this.delayNode = this.ctx.createDelay(1);

    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = gain;

    this.initialNode = this.bufferToSource(recordedBuffer2);
    
    const splitter = this.ctx.createChannelSplitter(2);
    const merger = this.ctx.createChannelMerger(2);
    //const destination = this.ctx.createMediaStreamDestination();
    
    this.initialNode.connect(splitter);
    splitter.connect(this.delayNode, 0);
    splitter.connect(this.gainNode, 1);
    this.delayNode.connect(merger, 0, 0);
    this.gainNode.connect(merger, 0, 1);
    merger.connect(this.ctx.destination);
    this.initialNode.start();
  }

  kill() {
    this.killed = true;
    this.stop();
    this.ctx.close();
  }

  stop() {
    this.initialNode.stop();
  }

  bufferToSource(buffer) {
    let source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    return source;
  }

  setRecordingDelay(delay) {
    this.delay = delay;
    this.delayNode.delayTime.linearRampToValueAtTime(delay, this.ctx.currentTime + 2)
  }
}

class SafariAudioBufferRecorder {
  bufferSize = 4096;
  source;
  samples = [];
  context;
  output;

  constructor(context, stream) {
    this.samples[0] = []
    this.samples[1] = []
    this.source = context.createMediaStreamSource(stream);
    this.context = context;
    this.processor = this.context.createScriptProcessor(this.bufferSize, 2, 2);
    this.processor.onaudioprocess = this.process.bind(this);
  }

  start() {
    this.source.connect(this.processor)
    this.processor.connect(this.context.destination)
  }

  process(e) {
    this.samples[0].push(e.inputBuffer.getChannelData(0).slice())
    this.samples[1].push(e.inputBuffer.getChannelData(1).slice())
  }

  stop() {
    this.processor.disconnect();
    this.source.disconnect();
    this.output = this.context.createBuffer(2, this.samples[0].length*this.bufferSize, this.context.sampleRate);
    var that = this; //eslint-disable-line
    const one = this.output.getChannelData(0);
    this.samples[0].forEach((v, i, a, that) => { //eslint-disable-line
      one.set(v, i*this.bufferSize)
    })
    const two = this.output.getChannelData(1);
    this.samples[1].forEach((v, i, a, that) => { //eslint-disable-line
      two.set(v, i*this.bufferSize)
    })
  }
}