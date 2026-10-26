"""The bot token reaches curl on stdin, never on its command line."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import curlcfg  # noqa: E402


class CurlCfgTest(unittest.TestCase):
    def test_quoting(self):
        self.assertEqual(curlcfg.url_config('https://x/bot1:AA/a?q="b"\\'),
                         'url = "https://x/bot1:AA/a?q=\\"b\\"\\\\"\n')
        with self.assertRaises(ValueError):
            curlcfg.url_config("https://x/\nupload-file = /etc/passwd")

    def test_url_not_in_argv(self):
        with mock.patch("subprocess.run") as run:
            curlcfg.run(["curl", "-sS"], "https://api.telegram.org/bot123:SECRET/getMe", capture_output=True, text=True)
        argv, kw = run.call_args[0][0], run.call_args[1]
        self.assertEqual(argv, ["curl", "-sS", "-K", "-"])
        self.assertNotIn("SECRET", " ".join(argv))
        self.assertIn("SECRET", kw["input"])

    def test_real_curl_reads_the_url(self):
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            f.write("ok-from-file")
        r = curlcfg.run(["curl", "-sS"], Path(f.name).as_uri(), capture_output=True, text=True)
        Path(f.name).unlink()
        self.assertEqual(r.stdout, "ok-from-file")


if __name__ == "__main__":
    unittest.main()
