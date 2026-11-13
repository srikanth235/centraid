import shutil
import tempfile
import unittest
from pathlib import Path

from adapter_train import checkpoints, storage
from test_storage import FakeS3


class CheckpointsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ckpt-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self._saved = dict(storage._BACKENDS)
        self.s3 = FakeS3()
        storage.use_backend("s3", storage.S3Backend(self.s3))
        self.addCleanup(lambda: storage._BACKENDS.update(self._saved))

    def local(self, step):
        d = self.tmp / ("l%d" % step)
        shutil.rmtree(d, ignore_errors=True)  # a step is published to every root; each publish writes its marker into its own copy
        (d / "adapter").mkdir(parents=True)
        (d / "adapter" / "w").write_text("weights-%d" % step)
        (d / "state.json").write_text('{"step": %d}' % step)
        return d

    def roots(self):
        return [str(self.tmp / "remote"), "s3://bkt/ckpts"]

    def test_the_newest_complete_checkpoint_is_resumed(self):
        for root in self.roots():
            self.assertIsNone(checkpoints.newest(root))
            for step in (10, 20, 30):
                checkpoints.publish(self.local(step), root, step, keep=5)
            self.assertEqual(checkpoints.newest(root), (30, "ckpt-00000030"), root)
            step, d = checkpoints.fetch_newest(root, self.tmp / "work")
            self.assertEqual(step, 30)
            self.assertEqual((d / "adapter" / "w").read_text(), "weights-30")

    def test_an_upload_cut_off_before_the_marker_is_not_a_checkpoint(self):
        for root in self.roots():
            checkpoints.publish(self.local(10), root, 10, keep=5)
            # step 20's files arrive, the marker does not (a Spot reclaim mid-upload)
            storage.put_tree(self.local(20), storage.join(root, checkpoints.name_of(20)))
            self.assertEqual(checkpoints.newest(root), (10, "ckpt-00000010"), root)

    def test_only_the_newest_few_are_kept_and_never_an_incomplete_one_counted(self):
        for root in self.roots():
            for step in (1, 2, 3, 4):
                checkpoints.publish(self.local(step), root, step, keep=2)
            self.assertEqual([s for s, _ in checkpoints.complete(root)], [3, 4], root)

    def test_a_checkpoint_name_that_is_not_one_is_ignored(self):
        root = str(self.tmp / "remote")
        checkpoints.publish(self.local(5), root, 5, keep=2)
        (Path(root) / "ckpt-final").mkdir()
        (Path(root) / "ckpt-final" / "COMPLETE").write_text("x")
        self.assertEqual(checkpoints.newest(root), (5, "ckpt-00000005"))


if __name__ == "__main__":
    unittest.main()
