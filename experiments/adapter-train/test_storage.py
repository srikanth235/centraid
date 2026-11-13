import tempfile
import unittest
from pathlib import Path

from adapter_train import storage


class FakeS3:
    """boto3's client surface that S3Backend uses, over a dict; pages of two keys so pagination is exercised."""

    def __init__(self):
        self.objects = {}

    def upload_file(self, src, bucket, key):
        self.objects[(bucket, key)] = Path(src).read_bytes()

    def download_file(self, bucket, key, dest):
        if (bucket, key) not in self.objects:
            raise KeyError(key)
        Path(dest).write_bytes(self.objects[(bucket, key)])

    def list_objects_v2(self, Bucket, Prefix, ContinuationToken=None):
        keys = sorted(k for b, k in self.objects if b == Bucket and k.startswith(Prefix))
        start = int(ContinuationToken or 0)
        page = keys[start:start + 2]
        out = {"Contents": [{"Key": k} for k in page]}
        if start + 2 < len(keys):
            out["NextContinuationToken"] = str(start + 2)
        return out

    def delete_object(self, Bucket, Key):
        self.objects.pop((Bucket, Key), None)


class FakeBlob:
    def __init__(self, store, bucket, name):
        self.store, self.bucket, self.name = store, bucket, name

    def upload_from_filename(self, path):
        self.store[(self.bucket, self.name)] = Path(path).read_bytes()

    def download_to_filename(self, path):
        Path(path).write_bytes(self.store[(self.bucket, self.name)])

    def delete(self):
        self.store.pop((self.bucket, self.name), None)


class FakeGcs:
    def __init__(self):
        self.objects = {}

    def bucket(self, name):
        outer = self

        class B:
            def blob(self, key):
                return FakeBlob(outer.objects, name, key)

        return B()

    def list_blobs(self, bucket, prefix):
        return [FakeBlob(self.objects, b, k) for b, k in sorted(self.objects) if b == bucket and k.startswith(prefix)]


class StorageTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="storage-test-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.s3, self.gcs = FakeS3(), FakeGcs()
        self._saved = dict(storage._BACKENDS)
        storage.use_backend("s3", storage.S3Backend(self.s3))
        storage.use_backend("gs", storage.GsBackend(self.gcs))
        self.addCleanup(lambda: storage._BACKENDS.update(self._saved))

    def tree(self):
        src = self.tmp / "src"
        (src / "adapter").mkdir(parents=True, exist_ok=True)
        (src / "adapter" / "a.bin").write_bytes(b"aaa")
        (src / "state.json").write_bytes(b"{}")
        (src / "COMPLETE").write_bytes(b"1")
        return src

    def roots(self):
        return [str(self.tmp / "dest"), "s3://bkt/run/ckpt", "gs://bkt/run/ckpt"]

    def test_split_and_join(self):
        self.assertEqual(storage.split("s3://b/a/b/"), ("s3", "b", "a/b"))
        self.assertEqual(storage.split("/mnt/x"), ("", "", "/mnt/x"))
        self.assertEqual(storage.join("s3://b/a/", "/c", "d"), "s3://b/a/c/d")
        with self.assertRaises(storage.StorageError):
            storage.split("ftp://b/x")

    def test_a_tree_round_trips_on_every_backend(self):
        for root in self.roots():
            storage.put_tree(self.tree(), root)
            self.assertEqual(storage.files(root), ["COMPLETE", "adapter/a.bin", "state.json"], root)
            self.assertEqual(storage.names(root), ["COMPLETE", "adapter", "state.json"], root)
            got = storage.get_tree(root, self.tmp / ("got-" + root[:2].strip(":/")))
            self.assertEqual((got / "adapter" / "a.bin").read_bytes(), b"aaa", root)
            self.assertTrue(storage.exists(storage.join(root, "state.json")), root)
            self.assertFalse(storage.exists(storage.join(root, "nope")), root)
            storage.delete_tree(root)
            self.assertEqual(storage.files(root), [], root)

    def test_s3_listing_follows_the_pages(self):
        for i in range(5):
            self.s3.objects[("bkt", "p/%d" % i)] = b"x"
        self.assertEqual(len(storage.files("s3://bkt/p")), 5)

    def test_files_named_last_are_uploaded_last(self):
        order = []
        real = storage.put_file
        storage.put_file = lambda src, uri: (order.append(Path(uri).name), real(src, uri))[1]
        try:
            storage.put_tree(self.tree(), "s3://bkt/x", last=("COMPLETE",))
        finally:
            storage.put_file = real
        self.assertEqual(order[-1], "COMPLETE")
        self.assertEqual(sorted(order), ["COMPLETE", "a.bin", "state.json"])

    def test_text_round_trips_and_a_missing_local_file_is_an_error(self):
        for root in self.roots():
            storage.write_text(storage.join(root, "job.json"), "héllo", self.tmp / "scratch")
            self.assertEqual(storage.read_text(storage.join(root, "job.json"), self.tmp / "scratch"), "héllo")
        with self.assertRaises(storage.StorageError):
            storage.get_file(str(self.tmp / "missing"), self.tmp / "d")

    def test_a_prefix_is_not_a_sibling_with_the_same_start(self):
        (self.tmp / "src.txt").write_text("x")
        storage.put_file(self.tmp / "src.txt", "s3://bkt/ckpt-1/a")
        storage.put_file(self.tmp / "src.txt", "s3://bkt/ckpt-10/a")
        self.assertEqual(storage.files("s3://bkt/ckpt-1"), ["a"])


if __name__ == "__main__":
    unittest.main()
