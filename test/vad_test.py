import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from vad import (  # noqa: E402
    SpeechSegment,
    VadSettings,
    clamp_segments,
    clip_timestamps,
    full_audio_clips,
    merge_vad_chunks,
)


class VadPlanningTest(unittest.TestCase):
    def test_clamp_segments_drops_invalid_and_merges_overlaps(self):
        self.assertEqual(
            clamp_segments(
                [
                    SpeechSegment(-1, 0.5),
                    SpeechSegment(0.4, 1.2),
                    SpeechSegment(4, 4),
                    SpeechSegment(2, 9),
                ],
                duration=3,
            ),
            [
                SpeechSegment(0.0, 1.2),
                SpeechSegment(2.0, 3.0),
            ],
        )

    def test_merge_vad_chunks_preserves_source_spans(self):
        chunks = merge_vad_chunks(
            [
                SpeechSegment(0, 5),
                SpeechSegment(6, 11),
                SpeechSegment(12, 20),
            ],
            chunk_size=12,
        )

        self.assertEqual(
            chunks,
            [
                merge_chunk(0, 11, [(0, 5), (6, 11)]),
                merge_chunk(12, 20, [(12, 20)]),
            ],
        )
        self.assertEqual(clip_timestamps(chunks), [0, 11, 12, 20])

    def test_full_audio_clips_use_same_clip_contract(self):
        chunks, metadata = full_audio_clips(9.25)

        self.assertEqual(chunks, [merge_chunk(0, 9.25, [(0, 9.25)])])
        self.assertEqual(clip_timestamps(chunks), [0, 9.25])
        self.assertEqual(
            metadata.to_json(),
            {
                "enabled": False,
                "method": "none",
                "speech_segments": 1,
                "merged_chunks": 1,
                "audio_seconds": 9.25,
                "speech_seconds": 9.25,
                "transcribed_seconds": 9.25,
            },
        )

    def test_vad_settings_validate_thresholds(self):
        VadSettings(onset=0.5, chunk_size=30).validate()

        with self.assertRaises(ValueError):
            VadSettings(onset=1.2).validate()

        with self.assertRaises(ValueError):
            VadSettings(chunk_size=0).validate()


def merge_chunk(start, end, segments):
    from vad import VadChunk

    return VadChunk(
        start=start,
        end=end,
        segments=tuple(SpeechSegment(a, b) for a, b in segments),
    )


if __name__ == "__main__":
    unittest.main()
