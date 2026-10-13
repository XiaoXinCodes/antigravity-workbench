"""Encode actual VS Code keyframes as small GIFs with stable palettes and disclosure.

Requires Pillow and a CJK-capable font (AG_DEMO_FONT can override the default).
Capture first with scripts/capture-readme-demo.cjs; no model/network calls here.
"""
import json
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FONT = os.environ.get('AG_DEMO_FONT', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
CAPTIONS = {
    'zh-CN': {
        'accounts': '多账号，在一个工作台管理', 'search': '搜索账号，快速找到需要的身份',
        'compare': '比较同一模型的剩余额度', 'refresh': '刷新所选账号额度',
        'images': '图片工作室：保留任务与已有图片', 'imageAccount': '单独选择生图账号，查看它的额度',
        'reuse': '复用历史参数，接着创作', 'records': '查看本机模型与 Token 用量',
    },
    'en': {
        'accounts': 'Manage accounts in one workbench', 'search': 'Find the account you need',
        'compare': 'Compare quota for the same model', 'refresh': 'Refresh the selected account’s quota',
        'images': 'Image Studio: keep tasks and existing images', 'imageAccount': 'Choose an image account and check its quota',
        'reuse': 'Reuse saved parameters for your next creation', 'records': 'Inspect local model and Token usage',
    },
}

def build(language):
    folder = ROOT / '.test-results/readme-demo' / language
    receipt = json.loads((folder / 'capture-receipt.json').read_text())
    assert receipt['passed'] and receipt['imageModelRequests'] == 0 and not receipt['googleRequests']
    assert receipt['productionUi'] and receipt['syntheticAccounts']
    frames, durations = [], []
    for info in receipt['frames']:
        with Image.open(folder / info['file']) as source:
            source = source.convert('RGB')
            scale_x = source.width / info['viewport']['width']
            scale_y = source.height / info['viewport']['height']
            clip = info['clip']
            bounds = (round(clip['x'] * scale_x), round(clip['y'] * scale_y),
                      round((clip['x'] + clip['width']) * scale_x), round((clip['y'] + clip['height']) * scale_y))
            crop = source.crop(bounds)
        width = min(1100, crop.width)
        height = round(crop.height * width / crop.width)
        crop = crop.resize((width, height), Image.Resampling.LANCZOS)
        frame = Image.new('RGB', (width, height + 82), '#f7f8fc')
        frame.paste(crop, (0, 82))
        draw = ImageDraw.Draw(frame)
        draw.text((22, 8), CAPTIONS[language][info['chapter']], font=ImageFont.truetype(FONT, 24), fill='#252d42')
        disclosure = '演示数据 · 示例图片 · 未发送模型请求' if language == 'zh-CN' else 'Demo data · Sample image · No model requests'
        draw.text((22, 47), disclosure, font=ImageFont.truetype(FONT, 16), fill='#5b6478')
        draw.line((0, 81, width, 81), fill='#dfe3ed', width=1)
        frames.append(frame)
        durations.append(info['duration'])
    assert len({frame.size for frame in frames}) == 1
    # One shared palette prevents stationary UI colors from flashing between cuts.
    sample = Image.new('RGB', (550, 420 * len(frames)))
    for i, frame in enumerate(frames):
        sample.paste(frame.resize((550, 420)), (0, i * 420))
    palette = sample.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
    indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
    output = ROOT / 'docs/images' / ('workbench-demo-en.gif' if language == 'en' else 'workbench-demo-zh.gif')
    indexed[0].save(output, save_all=True, append_images=indexed[1:], duration=durations,
                    loop=0, optimize=True, disposal=1)
    with Image.open(output) as gif:
        assert gif.n_frames == len(frames)
        assert gif.size == frames[0].size
        assert output.stat().st_size < 2 * 1024 * 1024
        actual_duration = 0
        for i in range(gif.n_frames):
            gif.seek(i)
            actual_duration += gif.info['duration']
            assert gif.info['duration'] >= 700
        assert actual_duration == sum(durations)
    # Local contact sheet supports human review; it is not shipped in docs.
    sheet = Image.new('RGB', (550 * 3, round(frames[0].height * .5) * 3), 'white')
    for i, frame in enumerate(frames):
        thumb = frame.resize((550, round(frame.height * .5)), Image.Resampling.LANCZOS)
        sheet.paste(thumb, ((i % 3) * 550, (i // 3) * thumb.height))
    sheet.save(folder / 'contact-sheet.png')
    print(json.dumps({'file': str(output), 'bytes': output.stat().st_size,
                      'frames': len(frames), 'duration_ms': actual_duration, 'size': frames[0].size}))

if __name__ == '__main__':
    for locale in ['zh-CN', 'en']:
        build(locale)
