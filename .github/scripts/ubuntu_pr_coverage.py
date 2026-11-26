"""Check whether the Ubuntu release jobs passed for the exact tree merged to prod."""
import json
import os
import re
import sys
from urllib.error import URLError
from urllib.request import Request, urlopen

UBUNTU_JOBS = {
    "engine (22.12.0, ubuntu-24.04)",
    "engine (24, ubuntu-24.04)",
    "Fresh Ubuntu install and Chromium launch",
}


def tested_trees(get, run_id):
    jobs = get(f"/actions/runs/{run_id}/jobs?per_page=100")["jobs"]
    passed = {job["name"] for job in jobs if job["conclusion"] == "success"}
    if not UBUNTU_JOBS.issubset(passed):
        return

    # These archive names contain the PR test merge's GITHUB_SHA.
    artifacts = get(f"/actions/runs/{run_id}/artifacts?per_page=100")["artifacts"]
    names = {artifact["name"] for artifact in artifacts if not artifact["expired"]}
    for name in names:
        match = re.fullmatch(r"engine-ubuntu-24[.]04-node-24-([0-9a-f]{40})", name)
        if match and f"engine-ubuntu-24.04-node-22.12.0-{match[1]}" in names:
            yield get(f"/git/commits/{match[1]}")["tree"]["sha"]


def covered_by_pr(get, sha):
    pulls = get(f"/commits/{sha}/pulls")
    for pr in pulls:
        if pr["merged_at"] and pr["base"]["ref"] == "prod" and pr["merge_commit_sha"] == sha:
            head = pr["head"]
            break
    else:
        return False

    if not head.get("repo"):
        return False
    runs = get("/actions/workflows/native-ci.yml/runs"
               f"?event=pull_request&head_sha={head['sha']}&per_page=10")["workflow_runs"]
    # GitHub lists newest first. A later failed or pending run takes precedence.
    for run in runs:
        if run["head_branch"] != head["ref"] or run["head_repository"]["id"] != head["repo"]["id"]:
            continue
        if run["pull_requests"] and not any(item["number"] == pr["number"] for item in run["pull_requests"]):
            continue
        if run["conclusion"] != "success":
            return False
        merged_tree = get(f"/git/commits/{sha}")["tree"]["sha"]
        return merged_tree in tested_trees(get, run["id"])
    return False


def github_get(path):
    url = f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}{path}"
    headers = {"Accept": "application/vnd.github+json"}
    if os.environ.get("GH_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GH_TOKEN"]
    with urlopen(Request(url, headers=headers), timeout=10) as response:
        return json.load(response)


if __name__ == "__main__":
    try:
        covered = covered_by_pr(github_get, os.environ["GITHUB_SHA"])
    except (URLError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"Running Ubuntu because PR coverage could not be verified ({type(error).__name__}).",
              file=sys.stderr)
        covered = False
    print("covered=" + str(covered).lower())
