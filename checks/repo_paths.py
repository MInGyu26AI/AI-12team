"""검사가 collector/·server/·contract/ 와 저장소 루트(ai/)의 모듈을 import 하게 한다. 검사 파일마다 가장 먼저 import 한다."""
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
for _folder in (REPO, REPO / 'contract', REPO / 'server', REPO / 'collector'):
    if str(_folder) not in sys.path:
        sys.path.insert(1, str(_folder))
