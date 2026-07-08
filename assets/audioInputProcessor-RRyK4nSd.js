const DEFAULT_CHUNK_SIZE = 2048;
const AUDIO_INPUT_WORKLET_NAME = "audio-input-processor";

class AudioInputProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const configuredChunkSize = options?.processorOptions?.chunkSize;
    const normalizedChunkSize =
      Number.isFinite(configuredChunkSize) && configuredChunkSize > 0
        ? Math.max(1, Math.floor(configuredChunkSize))
        : DEFAULT_CHUNK_SIZE;

    this.chunkSize = normalizedChunkSize;
    this.chunkBuffer = new Float32Array(this.chunkSize);
    this.bufferedSampleCount = 0;
  }

  emitChunk() {
    const samples = this.chunkBuffer;
    let lastNonZeroIndex = -1;

    for (let index = samples.length - 1; index >= 0; index -= 1) {
      if (samples[index] !== 0) {
        lastNonZeroIndex = index;
        break;
      }
    }

    this.port.postMessage(
      {
        type: "chunk",
        samples,
        lastNonZeroIndex,
      },
      [samples.buffer],
    );

    this.chunkBuffer = new Float32Array(this.chunkSize);
    this.bufferedSampleCount = 0;
  }

  process(inputs, outputs) {
    const outputChannels = outputs[0] ?? [];
    outputChannels.forEach((channel) => {
      channel.fill(0);
    });

    const inputChannel = inputs[0]?.[0];
    if (!inputChannel || inputChannel.length === 0) {
      return true;
    }

    let readIndex = 0;
    while (readIndex < inputChannel.length) {
      const writeLength = Math.min(
        this.chunkSize - this.bufferedSampleCount,
        inputChannel.length - readIndex,
      );

      this.chunkBuffer.set(
        inputChannel.subarray(readIndex, readIndex + writeLength),
        this.bufferedSampleCount,
      );
      this.bufferedSampleCount += writeLength;
      readIndex += writeLength;

      if (this.bufferedSampleCount === this.chunkSize) {
        this.emitChunk();
      }
    }

    return true;
  }
}

registerProcessor(AUDIO_INPUT_WORKLET_NAME, AudioInputProcessor);
