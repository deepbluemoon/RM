"""M2 구조 — 공유 인코더 + 헤드 2개(① 위법 소지 이진, ② 법률 5개 다중 레이블). 학습(training/)과 서빙이 함께 쓴다.

저장 형식: 인코더는 save_pretrained(폴더), 헤드는 heads.pt. torch·transformers 가 있을 때만 import 한다.
"""
from __future__ import annotations

from pathlib import Path

import torch
from torch import nn
from transformers import AutoModel

N_LAWS = 5


class IllegalModel(nn.Module):
    def __init__(self, encoder: nn.Module, dropout: float = 0.1):
        super().__init__()
        self.encoder = encoder
        hidden = encoder.config.hidden_size
        self.dropout = nn.Dropout(dropout)
        self.bin_head = nn.Linear(hidden, 1)
        self.law_head = nn.Linear(hidden, N_LAWS)

    def forward(self, input_ids, attention_mask, token_type_ids=None, **_):
        h = self.encoder(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state[:, 0]
        h = self.dropout(h)
        return self.bin_head(h), self.law_head(h)

    @classmethod
    def from_base(cls, base: str | Path) -> "IllegalModel":
        return cls(AutoModel.from_pretrained(base))

    def save(self, path: Path) -> None:
        path.mkdir(parents=True, exist_ok=True)
        self.encoder.save_pretrained(path)
        torch.save({"bin_head": self.bin_head.state_dict(), "law_head": self.law_head.state_dict()}, path / "heads.pt")

    @classmethod
    def load(cls, path: Path) -> "IllegalModel":
        m = cls(AutoModel.from_pretrained(path, torch_dtype=torch.float32))
        heads = torch.load(path / "heads.pt", map_location="cpu", weights_only=True)
        m.bin_head.load_state_dict(heads["bin_head"])
        m.law_head.load_state_dict(heads["law_head"])
        return m
