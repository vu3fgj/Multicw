const CW_AI_NOISE_REDUCTION_WORKLET_NAME = "cw-ai-noise-reduction-processor";

const DOWNSAMPLE_FILTER_RADIUS = 128;
const UPSAMPLE_FILTER_RADIUS = 16;
const RENDER_QUANTUM_SAMPLES = 128;
const OUTPUT_RAMP_SECONDS = 0.08;
const MODEL_FADE_SECONDS = 0.08;
const DEFAULT_OUTPUT_LATENCY_HOPS = 6;
const MIN_OUTPUT_LATENCY_HOPS = 1;
const MAX_OUTPUT_LATENCY_HOPS = 6;
const CW_V2_MODEL_ID = 3;

class Fifo {
  constructor(capacity) {
    this.values = new Float32Array(capacity);
    this.capacity = capacity;
    this.readIndex = 0;
    this.writeIndex = 0;
    this.lengthValue = 0;
  }

  push(value) {
    if (this.lengthValue >= this.capacity) {
      this.readIndex = (this.readIndex + 1) % this.capacity;
      this.lengthValue -= 1;
    }
    this.values[this.writeIndex] = Number.isFinite(value) ? value : 0;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    this.lengthValue += 1;
  }

  shift() {
    if (this.lengthValue <= 0) return 0;
    const value = this.values[this.readIndex];
    this.readIndex = (this.readIndex + 1) % this.capacity;
    this.lengthValue -= 1;
    return value;
  }

  get length() {
    return this.lengthValue;
  }

  clear() {
    this.readIndex = 0;
    this.writeIndex = 0;
    this.lengthValue = 0;
  }
}

class SincResampler {
  constructor(fromRate, toRate, onSample, radius) {
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.onSample = onSample;
    this.radius = radius;
    this.step = fromRate / toRate;
    this.position = 0;
    this.baseIndex = -radius;
    this.buffer = new Array(radius).fill(0);
    this.cutoff = Math.min(fromRate, toRate) * 0.475;
    this.cutoffNorm = this.cutoff / fromRate;
  }

  process(input) {
    for (let index = 0; index < input.length; index += 1) {
      this.buffer.push(input[index]);
    }

    const lastIndex = this.baseIndex + this.buffer.length - 1;
    while (this.position + this.radius <= lastIndex) {
      this.onSample(this.sampleAt(this.position));
      this.position += this.step;
    }

    const keepFrom = Math.floor(this.position) - this.radius - 1;
    const drop = Math.max(0, keepFrom - this.baseIndex);
    if (drop > 0) {
      this.buffer.splice(0, drop);
      this.baseIndex += drop;
    }
  }

  sampleAt(position) {
    const center = Math.floor(position);
    let acc = 0;
    let weightSum = 0;

    for (
      let index = center - this.radius;
      index <= center + this.radius;
      index += 1
    ) {
      const sample = this.buffer[index - this.baseIndex] ?? 0;
      const distance = position - index;
      const absDistance = Math.abs(distance);
      if (absDistance > this.radius) continue;

      const sincArg = 2 * this.cutoffNorm * distance;
      const sinc =
        Math.abs(sincArg) < 1e-8
          ? 1
          : Math.sin(Math.PI * sincArg) / (Math.PI * sincArg);
      const x = absDistance / this.radius;
      const window =
        0.42 +
        0.5 * Math.cos(Math.PI * x) +
        0.08 * Math.cos(2 * Math.PI * x);
      const weight = 2 * this.cutoffNorm * sinc * window;
      acc += sample * weight;
      weightSum += weight;
    }

    return Math.abs(weightSum) > 1e-8 ? acc / weightSum : 0;
  }
}

class CwAiNoiseReductionProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const initialEnabled = Boolean(options?.processorOptions?.enabled);

    this.ready = false;
    this.processing = initialEnabled;
    this.error = null;
    this.denoiseRate = 9600;
    this.hopLength = 144;
    this.inputBins = 129;
    this.hopFill = 0;
    this.inputHop = null;
    this.outputHop = null;
    this.gainsView = null;
    this.resampleInput = new Float32Array(this.hopLength);
    this.outputQueue = new Fifo(Math.max(16384, Math.ceil(sampleRate * 2)));
    this.outputLatencyHops = DEFAULT_OUTPUT_LATENCY_HOPS;
    this.downsampler = new SincResampler(
      sampleRate,
      this.denoiseRate,
      (sample) => this.acceptDenoiseSample(sample),
      DOWNSAMPLE_FILTER_RADIUS,
    );
    this.upsampler = new SincResampler(
      this.denoiseRate,
      sampleRate,
      (sample) => this.outputQueue.push(sample),
      UPSAMPLE_FILTER_RADIUS,
    );
    this.outputPrimed = false;
    this.outputLatencySamples = this.calculateOutputLatencySamples();
    this.outputRampSamples = this.calculateOutputRampSamples();
    this.fallbackGain = 1;
    this.wet = initialEnabled ? 1 : 0;
    this.targetWet = this.wet;
    this.wetRampStart = this.wet;
    this.wetRampSamples = this.calculateWetRampSamples();
    this.wetRampRemaining = 0;
    this.modelFadeSamples = this.calculateWetRampSamples();
    this.modelFadeRemaining = this.modelFadeSamples;
    this.dryDelayQueue = new Fifo(16384);
    this.dryDelaySamples = 0;
    this.wasmBytes = options?.processorOptions?.wasmBytes ?? null;

    this.port.onmessage = (event) => this.handleMessage(event.data);
    this.loadWasm();
  }

  async loadWasm() {
    try {
      if (!this.wasmBytes) {
        throw new Error("denoise-cw.wasm bytes were not provided");
      }

      const result = await WebAssembly.instantiate(this.wasmBytes, {
        env: {
          memory: new WebAssembly.Memory({ initial: 256 }),
          emscripten_notify_memory_growth: () => {},
        },
        wasi_snapshot_preview1: {
          proc_exit: () => {},
        },
      });

      this.exports = result.instance.exports;
      const status = this.exports.denoise_web_init();
      if (status !== 0) {
        throw new Error(`denoise init failed: ${status}`);
      }
      if (typeof this.exports.denoise_web_set_model === "function") {
        const modelStatus = this.exports.denoise_web_set_model(CW_V2_MODEL_ID);
        if (modelStatus !== 0) {
          throw new Error(`model select failed: ${modelStatus}`);
        }
      }

      this.refreshWasmViews();
      this.downsampler = new SincResampler(
        sampleRate,
        this.denoiseRate,
        (sample) => this.acceptDenoiseSample(sample),
        DOWNSAMPLE_FILTER_RADIUS,
      );
      this.upsampler = new SincResampler(
        this.denoiseRate,
        sampleRate,
        (sample) => this.outputQueue.push(sample),
        UPSAMPLE_FILTER_RADIUS,
      );
      this.outputQueue.clear();
      this.outputPrimed = false;
      this.outputLatencySamples = this.calculateOutputLatencySamples();
      this.outputRampSamples = this.calculateOutputRampSamples();
      this.fallbackGain = 1;
      this.wetRampSamples = this.calculateWetRampSamples();
      this.modelFadeSamples = this.calculateWetRampSamples();
      this.modelFadeRemaining = this.modelFadeSamples;
      this.ready = true;
      this.port.postMessage({
        type: "ready",
        sampleRate,
        denoiseRate: this.denoiseRate,
        hopLength: this.hopLength,
        inputBins: this.inputBins,
      });
    } catch (error) {
      this.error = error;
      this.port.postMessage({
        type: "error",
        message: error?.message || String(error),
      });
    }
  }

  handleMessage(data) {
    if (data?.type !== "config") return;

    if (typeof data.processing === "boolean") {
      this.setProcessing(data.processing);
    }

    const requestedWet =
      typeof data.wet === "number" && Number.isFinite(data.wet)
        ? data.wet
        : data.enabled
          ? 1
          : 0;
    const nextWet = data.enabled
      ? Math.max(0, Math.min(1, requestedWet))
      : 0;
    if (nextWet !== this.targetWet) {
      this.targetWet = nextWet;
      this.wetRampStart = this.wet;
      this.wetRampSamples = this.calculateWetRampSamples();
      this.wetRampRemaining = this.wetRampSamples;
    }

    if (typeof data.outputLatencyHops === "number") {
      const nextOutputLatencyHops = Math.max(
        MIN_OUTPUT_LATENCY_HOPS,
        Math.min(MAX_OUTPUT_LATENCY_HOPS, Math.trunc(data.outputLatencyHops)),
      );
      if (nextOutputLatencyHops !== this.outputLatencyHops) {
        this.outputLatencyHops = nextOutputLatencyHops;
        this.outputLatencySamples = this.calculateOutputLatencySamples();
      }
    }
  }

  setProcessing(active) {
    if (this.processing === active) return;

    this.processing = active;
    this.hopFill = 0;
    this.outputQueue.clear();
    this.outputPrimed = false;
    this.fallbackGain = 1;
    this.resetDryDelay();
    if (active) {
      this.modelFadeRemaining = this.modelFadeSamples;
    }
  }

  refreshWasmViews() {
    this.denoiseRate = this.exports.denoise_web_sample_rate();
    this.hopLength = this.exports.denoise_web_hop_length();
    this.inputBins = this.exports.denoise_web_input_bins();
    this.resampleInput = new Float32Array(this.hopLength);

    const memory = this.exports.memory;
    const inputPtr = this.exports.denoise_web_input_ptr();
    const outputPtr = this.exports.denoise_web_output_ptr();
    const gainsPtr = this.exports.denoise_web_gains_ptr();
    this.inputHop = new Float32Array(memory.buffer, inputPtr, this.hopLength);
    this.outputHop = new Float32Array(memory.buffer, outputPtr, this.hopLength);
    this.gainsView = new Float32Array(memory.buffer, gainsPtr, this.inputBins);
    this.hopFill = 0;
    this.dryDelaySamples = this.calculateDryDelaySamples();
    this.dryDelayQueue = new Fifo(
      Math.max(16384, this.dryDelaySamples + this.hopLength * 4),
    );
    this.resetDryDelay();
  }

  calculateDryDelaySamples() {
    if (typeof this.exports?.denoise_web_algorithmic_latency_hops !== "function") {
      return 0;
    }
    const latencyHops = this.exports.denoise_web_algorithmic_latency_hops();
    return Math.max(0, Math.trunc(latencyHops) * this.hopLength);
  }

  resetDryDelay() {
    this.dryDelayQueue.clear();
  }

  nextDelayedDrySample(sample) {
    if (this.dryDelaySamples <= 0) return sample;
    this.dryDelayQueue.push(sample);
    if (this.dryDelayQueue.length <= this.dryDelaySamples) return null;
    return this.dryDelayQueue.shift();
  }

  calculateOutputLatencySamples() {
    const hopDurationSamples = (this.hopLength * sampleRate) / this.denoiseRate;
    return Math.max(
      RENDER_QUANTUM_SAMPLES * 2,
      Math.ceil(hopDurationSamples * this.outputLatencyHops),
    );
  }

  calculateOutputRampSamples() {
    return Math.max(RENDER_QUANTUM_SAMPLES, Math.ceil(sampleRate * OUTPUT_RAMP_SECONDS));
  }

  calculateWetRampSamples() {
    return Math.max(this.hopLength, Math.ceil(this.denoiseRate * MODEL_FADE_SECONDS));
  }

  nextWetValue() {
    if (this.wetRampRemaining <= 0) {
      this.wet = this.targetWet;
      return this.wet;
    }

    const progress =
      1 - (this.wetRampRemaining / Math.max(1, this.wetRampSamples));
    this.wet =
      this.wetRampStart + (this.targetWet - this.wetRampStart) * progress;
    this.wetRampRemaining -= 1;
    return Math.max(0, Math.min(1, this.wet));
  }

  nextModelFadeGain() {
    if (this.modelFadeRemaining <= 0) return 1;
    const gain = 1 - (this.modelFadeRemaining / this.modelFadeSamples);
    this.modelFadeRemaining -= 1;
    return Math.max(0, Math.min(1, gain));
  }

  acceptDenoiseSample(sample) {
    if (!this.ready) return;

    this.inputHop[this.hopFill] = sample;
    this.hopFill += 1;
    if (this.hopFill < this.hopLength) return;

    const produced = this.exports.denoise_web_process_hop(1);
    if (produced >= 0) {
      const resampleInput = this.resampleInput;
      let filled = 0;
      for (let index = 0; index < this.hopLength; index += 1) {
        const dry = this.nextDelayedDrySample(this.inputHop[index]);
        if (dry == null) continue;
        const processed = produced ? this.outputHop[index] : dry;
        const wet = this.nextWetValue() * this.nextModelFadeGain();
        resampleInput[filled] = dry + (processed - dry) * wet;
        filled += 1;
      }
      if (filled > 0) {
        this.upsampler.process(
          filled === this.hopLength
            ? resampleInput
            : resampleInput.subarray(0, filled),
        );
      }
    }
    this.hopFill = 0;
  }

  nextOutputSample() {
    if (!this.outputPrimed) {
      if (this.outputQueue.length < this.outputLatencySamples) return null;
      this.outputPrimed = true;
    }

    if (this.outputQueue.length <= 0) {
      this.outputPrimed = false;
      return null;
    }

    return this.outputQueue.shift();
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;

    if (!input) {
      output.fill(0);
      return true;
    }

    if (!this.ready || this.error || !this.processing) {
      output.set(input);
      return true;
    }

    this.downsampler.process(input);

    // Crossfade between the live-input fallback and the (delayed) denoiser
    // output instead of hard-switching, so priming and underruns never
    // introduce a sample-level discontinuity.
    const fallbackStep = 1 / Math.max(1, this.outputRampSamples);
    for (let index = 0; index < output.length; index += 1) {
      const value = this.nextOutputSample();
      this.fallbackGain =
        value == null
          ? Math.min(1, this.fallbackGain + fallbackStep)
          : Math.max(0, this.fallbackGain - fallbackStep);
      const mixed =
        input[index] * this.fallbackGain +
        (value ?? 0) * (1 - this.fallbackGain);
      output[index] = Math.max(-1, Math.min(1, mixed));
    }
    return true;
  }
}

registerProcessor(
  CW_AI_NOISE_REDUCTION_WORKLET_NAME,
  CwAiNoiseReductionProcessor,
);
