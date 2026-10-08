# 品牌素材

项目采用 A、轨道环与基座标志。原图由 ChatGPT 图像生成工具生成，并选用 A 方案作为项目标志。原始素材 `antigravity-workbench-a-original.png` 为 1254×1254 RGB PNG，青紫配色、白色背景，不是 Google 官方图标，也不表示官方认可或合作。

原图保留不变，SHA256：`ea22ed5c8920fe8fa76ef4151b80f7e37a3ed7ec6b8eaa798a8d1ea59bc041a6`。

派生 PNG 去除白底，并对边缘做去白处理；不修改实体内部颜色，不裁切 A、轨道或基座。整体平移以平衡可见边界留白后等比缩放。活动栏 SVG 从同一透明轮廓生成单色矢量，由 VS Code 使用主题前景色绘制。

| 文件 | 用途 | 尺寸 | SHA256 |
| --- | --- | --- | --- |
| `media/icon.png` | 扩展清单图标 | 256×256 | `53da8abcb2ee4bd957fb8dd78140f6fcf0325f0588017e0dfdfc5ede833153b7` |
| `media/brand-logo.png` | README 品牌图 | 512×512 | `913ff0d96626b16c8dc7a160ab3c19e3759a5ce9f04accccd8ded00b40929b84` |
| `media/workbench.svg` | VS Code 活动栏 | 24×24 viewBox | `dc617ecef403c7889cd0f9b4410ed70bcd093297436b73906e20525190688505` |

从仓库根目录依次运行：

```sh
powershell -NoProfile -File scripts/build-brand-assets.ps1
python3 scripts/build-activity-icon.py
```

PNG 脚本使用 Windows 自带 GDI+，SVG 脚本只用 Python 标准库；无需额外图像依赖。编码器差异可能影响压缩字节，更新素材后需核验像素、尺寸和摘要。

README 顶部使用 GitHub 支持的居中 HTML。活动栏清单引用 `media/workbench.svg`，与扩展清单的 PNG 图标是不同资源。SVG 遵循 [VS Code 活动栏图标规范](https://code.visualstudio.com/api/references/contribution-points#contributes.viewsContainers)：24×24、居中、单色。

原图和生成脚本进入源码交付，不进入 VSIX。派生图进入安装包，项目自有素材适用根目录 [LICENSE](../../LICENSE)；商标使用仍受适用法律约束，本说明不授予额外商标授权。原图与派生链已核对，完整生成提示词和可能的参考素材清单未在源码内归档；这不是对所有潜在第三方权利的保证。
