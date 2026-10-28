# Conformance samples

Media the conformance suite uploads. All files were made by the Cuelor authors for this repository and
are licensed under Apache-2.0, like the rest of the repository. None of them contains recorded speech.

| File | Contents | How it was made |
|---|---|---|
| `en.wav` | "The quick brown fox jumps over the lazy dog." (3.44 s) | Synthesised with eSpeak NG (voice `en-us`, 150 words per minute), converted to 16 kHz mono 16-bit PCM |
| `zh.wav` | "今天天气很好，我们去公园散步。" (4.97 s) | Synthesised with eSpeak NG (voice `cmn`, 150 words per minute), converted to 16 kHz mono 16-bit PCM |
| `video.mp4` | 1 s of a solid blue 64×64 frame, no sound | Generated with FFmpeg's `color` source, H.264 |

eSpeak NG is a formant synthesiser: its output contains no recorded voice samples. We used the
WebAssembly build published on npm as `espeak-ng@1.0.2`. macOS `say` was deliberately not used, because
its licence does not allow publishing the output.

**Known text in the files.** Each WAV carries its language and text as JSON in the RIFF `LIST/INFO/ICMT`
(comment) chunk, for example `{"language":"en","text":"…"}`. Real recognisers ignore the chunk. The
example plugin's fake upstream reads it to return the known text, so tiers B and C can run without a
real recogniser. `samples.json` lists the same text, language and duration for the suite.

**Known risk: synthesised speech.** C1 needs speech with a known text and duration, and these samples
are synthesised so that their licence is clear. Whether real speech recognisers read them with a
character error rate below 30 % (C1's threshold) has not been checked; they are intelligible to a
listener. If they turn out to be too hard, they will be replaced with recorded speech under a clear
licence. This does not affect the meaning of the protocol.

## Regenerating

```sh
npm install espeak-ng@1.0.2   # in a scratch directory
node gen-speech.mjs en-us "The quick brown fox jumps over the lazy dog." en-raw.wav
ffmpeg -i en-raw.wav -ac 1 -ar 16000 -c:a pcm_s16le -bitexact -map_metadata -1 \
  -metadata comment='{"language":"en","text":"The quick brown fox jumps over the lazy dog."}' en.wav
ffmpeg -f lavfi -i color=c=0x3366cc:s=64x64:d=1:r=10 -c:v libx264 -preset veryslow -crf 40 \
  -pix_fmt yuv420p -g 10 -movflags +faststart -map_metadata -1 -fflags +bitexact video.mp4
```

where `gen-speech.mjs` is:

```js
import ESpeakNg from "espeak-ng";
import { writeFileSync } from "node:fs";
const [voice, text, out] = process.argv.slice(2);
const espeak = await ESpeakNg({ arguments: ["-v", voice, "-s", "150", "-w", "out.wav", text] });
writeFileSync(out, espeak.FS.readFile("out.wav"));
```
