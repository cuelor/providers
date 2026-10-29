# Conformance samples

Media the conformance suite uploads.

**Licence.** `video.mp4` was made by the Cuelor authors for this repository and is licensed under
Apache-2.0, like the rest of the repository. The two WAV files are **not** under Apache-2.0: they are
excerpts of [LibriVox](https://librivox.org) recordings, which LibriVox places in the public domain
(no rights reserved; no attribution is required), reading texts that are in the public domain too.
Their sources are given below.

| File | Contents | Source |
|---|---|---|
| `en.wav` | "Alice was beginning to get very tired of sitting by her sister on the bank and of having nothing to do." (5.86 s) | LibriVox recording of *Alice's Adventures in Wonderland* by Lewis Carroll (1865), chapter 1: Internet Archive item `alice_in_wonderland_librivox`, file `wonderland_ch_01_64kb.mp3`, from 15.76 s |
| `zh.wav` | "但有一件小事，却于我有意义，将我从坏脾气里拖开，使我至今忘记不得。" (7.42 s) | LibriVox recording of 《呐喊》 (*Call to Arms*) by Lu Xun, the story 《一件小事》 (1919): Internet Archive item `call_to_arms_jl_librivox`, file `calltoarms_06_lu_64kb.mp3`, from 31.74 s |
| `video.mp4` | 1 s of a solid blue 64×64 frame, no sound | Generated with FFmpeg's `color` source, H.264 |

Both are recorded human speech; no speaker information is kept in the files or here. The texts
are the printed texts (the Chinese one from the Wikisource edition, written in simplified characters);
the readers follow them word for word. Each excerpt is one sentence, cut with about 0.2 s of silence at
each end, and converted to 16 kHz mono 16-bit PCM.

**Known text in the files.** Each WAV carries its language and text as JSON in the RIFF `LIST/INFO/ICMT`
(comment) chunk, for example `{"language":"en","text":"…"}`, and no other metadata. Real recognisers
ignore the chunk. The example plugin's fake upstream reads it to return the known text, so tiers B and
C can run without a real recogniser. `samples.json` lists the same text, language and duration for the
suite; a unit test checks the files against it.

## Regenerating

Download the two MP3 files from the Internet Archive items above, then:

```sh
ffmpeg -ss 15.76 -t 5.86 -i wonderland_ch_01_64kb.mp3 -ac 1 -ar 16000 -c:a pcm_s16le -bitexact -map_metadata -1 \
  -metadata comment='{"language":"en","text":"Alice was beginning to get very tired of sitting by her sister on the bank and of having nothing to do."}' en.wav
ffmpeg -ss 31.74 -t 7.42 -i calltoarms_06_lu_64kb.mp3 -ac 1 -ar 16000 -c:a pcm_s16le -bitexact -map_metadata -1 \
  -metadata comment='{"language":"zh","text":"但有一件小事，却于我有意义，将我从坏脾气里拖开，使我至今忘记不得。"}' zh.wav
ffmpeg -f lavfi -i color=c=0x3366cc:s=64x64:d=1:r=10 -c:v libx264 -preset veryslow -crf 40 \
  -pix_fmt yuv420p -g 10 -movflags +faststart -map_metadata -1 -fflags +bitexact video.mp4
```
