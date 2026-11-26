import unittest

from ubuntu_pr_coverage import UBUNTU_JOBS, covered_by_pr


class UbuntuCoverageTest(unittest.TestCase):
    def setUp(self):
        self.merge = "a" * 40
        self.head = "b" * 40
        self.test_merge = "c" * 40
        self.pull = {"number": 35, "base": {"ref": "prod"}, "merged_at": "today",
                     "merge_commit_sha": self.merge, "head": {"sha": self.head, "ref": "feature", "repo": {"id": 7}}}
        self.jobs = [{"name": name, "conclusion": "success"} for name in UBUNTU_JOBS]
        self.run = {"id": 17, "conclusion": "success", "head_branch": "feature",
                    "head_repository": {"id": 7}, "pull_requests": []}
        self.archives = [{"name": f"engine-ubuntu-24.04-node-{node}-{self.test_merge}", "expired": False}
                         for node in ("22.12.0", "24")]
        self.responses = {
            f"/commits/{self.merge}/pulls": [self.pull],
            f"/actions/workflows/native-ci.yml/runs?event=pull_request&head_sha={self.head}&per_page=10":
                {"workflow_runs": [self.run]},
            f"/git/commits/{self.merge}": {"tree": {"sha": "matching-tree"}},
            f"/git/commits/{self.test_merge}": {"tree": {"sha": "matching-tree"}},
            "/actions/runs/17/jobs?per_page=100": {"jobs": self.jobs},
            "/actions/runs/17/artifacts?per_page=100": {"artifacts": self.archives},
        }

    def covered(self):
        return covered_by_pr(self.responses.__getitem__, self.merge)

    def test_same_tree_with_different_commit_ids(self):
        self.assertTrue(self.covered())

    def test_changed_merge_tree(self):
        self.responses[f"/git/commits/{self.merge}"]["tree"]["sha"] = "new-tree"
        self.assertFalse(self.covered())

    def test_push_without_a_merged_pr(self):
        self.responses[f"/commits/{self.merge}/pulls"].clear()
        self.assertFalse(self.covered())

    def test_unsuccessful_pr(self):
        self.run["conclusion"] = "failure"
        self.assertFalse(self.covered())

    def test_older_success_cannot_replace_a_later_failed_run(self):
        runs = next(value["workflow_runs"] for value in self.responses.values()
                    if isinstance(value, dict) and "workflow_runs" in value)
        runs.insert(0, dict(self.run, conclusion="failure"))
        self.assertFalse(self.covered())

    def test_run_from_another_pull_request(self):
        self.run["pull_requests"] = [{"number": 34}]
        self.assertFalse(self.covered())

    def test_each_ubuntu_check_must_have_passed(self):
        for job in self.jobs:
            with self.subTest(job=job["name"]):
                job["conclusion"] = "skipped"
                self.assertFalse(self.covered())
                job["conclusion"] = "success"

    def test_both_archives_must_match_the_same_tested_commit(self):
        self.archives[0]["name"] = "engine-ubuntu-24.04-node-22.12.0-" + self.head
        self.assertFalse(self.covered())

    def test_expired_artifact(self):
        self.archives[0]["expired"] = True
        self.assertFalse(self.covered())


if __name__ == "__main__":
    unittest.main()
