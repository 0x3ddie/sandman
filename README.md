# catalog — sandman demo target

The service under test. Two branches differ by exactly one real defect so sandman
has something genuine to find:

| Branch | Defect A (nondeterministic facet order) | Defect B (500 on the last page) |
| --- | --- | --- |
| `demo/prev-lkg` | present | absent |
| `demo/lkg` | present | **present** |

Because defect A appears on both, sandman classifies it `PRE_EXISTING` and reports
it without opening a hotfix — it is not what this rollout broke. Defect B appears
only on `demo/lkg`, so it classifies as this rollout's regression and is eligible
for an automated fix.

```bash
pip install -r requirements.txt
python target-app/main.py    # listens on :8000
```
