"""把 Effort 的 .pth 权重导出为 ONNX，供 Node.js (onnxruntime-node) 直接推理。

Effort 的结构：CLIP ViT-L/14 视觉编码器 + 线性分类头。
self_attn 中的线性层被替换成 SVDResidualLinear，推理时权重为：
    W = weight_main + U_residual @ diag(S_residual) @ V_residual
这里把残差折叠回普通 Linear，导出的模型与原始检测器完全等价。

用法：
    python tools/export_onnx.py --weights weight/xxx.pth --output weight/onnx/xxx.onnx
"""

import argparse
from pathlib import Path

import torch
from transformers import CLIPVisionConfig, CLIPVisionModel


VISION_CONFIG = dict(
    hidden_size=1024,
    intermediate_size=4096,
    num_hidden_layers=24,
    num_attention_heads=16,
    image_size=224,
    patch_size=14,
    projection_dim=768,
    hidden_act="quick_gelu",
    layer_norm_eps=1e-5,
)

ATTN_PROJ = ("k_proj", "v_proj", "q_proj", "out_proj")


class EffortModel(torch.nn.Module):
    """视觉编码器 + 二分类头，输出 [1, 2] logits。"""

    def __init__(self):
        super().__init__()
        self.vision_model = CLIPVisionModel(CLIPVisionConfig(**VISION_CONFIG))
        self.head = torch.nn.Linear(1024, 2)

    def forward(self, pixel_values):
        pooled = self.vision_model(pixel_values=pixel_values).pooler_output
        return self.head(pooled)


def fold_checkpoint(state: dict) -> dict:
    """把 Effort 的 SVD 残差折叠成普通 Linear 权重，并改成 HF 的键名。"""
    folded = {}
    for raw_key, value in state.items():
        key = raw_key.replace("module.", "", 1)

        # backbone.xxx -> vision_model.xxx
        if key.startswith("backbone."):
            key = "vision_model." + key[len("backbone."):]

        # self_attn 的 weight_main 与残差相加，拼出完整权重
        if key.endswith(".weight_main"):
            base = key[: -len(".weight_main")]
            raw_base = raw_key[: -len(".weight_main")]
            residual = (
                state[raw_base + ".U_residual"]
                @ torch.diag(state[raw_base + ".S_residual"])
                @ state[raw_base + ".V_residual"]
            )
            folded[base + ".weight"] = (value + residual).contiguous()
            continue

        # 残差分量和只读副本不需要导出
        if key.split(".")[-1] in {"S_residual", "U_residual", "V_residual", "S_r", "U_r", "V_r"}:
            continue

        folded[key] = value
    return folded


def export(weights: Path, output: Path) -> None:
    checkpoint = torch.load(weights, map_location="cpu", weights_only=False)
    state = checkpoint.get("state_dict", checkpoint)

    model = EffortModel()
    missing, unexpected = model.load_state_dict(fold_checkpoint(state), strict=False)
    if missing or unexpected:
        raise RuntimeError(f"权重不匹配, missing={missing[:5]}, unexpected={unexpected[:5]}")
    model.eval()

    output.parent.mkdir(parents=True, exist_ok=True)
    dummy = torch.zeros(1, 3, 224, 224)
    torch.onnx.export(
        model,
        dummy,
        str(output),
        input_names=["pixel_values"],
        output_names=["logits"],
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )
    print(f"[ok] {weights.name} -> {output} ({output.stat().st_size / 1024**2:.0f} MB)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    export(args.weights, args.output)


if __name__ == "__main__":
    main()
