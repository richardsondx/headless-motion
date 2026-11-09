"""Recompute v5 vs real means over map-only frames 0-185 (cut is frame 186)."""
import sys, json
sys.path.insert(0, 'src')
import numpy as np
from PIL import Image
from checker import metrics

rows = []
for i in range(0, 186):
    a = np.array(Image.open(f'verify-seg4/evidence/work/full-192/ref-{i:04d}.png').convert('RGB'))
    b = np.array(Image.open(f'verify-seg4/evidence/work/full-192/v5-{i:04d}.png').convert('RGB'))
    s = metrics.ssim_frame(metrics.luma(a), metrics.luma(b))
    p = metrics.psnr_frame(a, b)
    rows.append({'frame': i, 'ssim': round(float(s), 4), 'psnr_db': round(float(p), 2)})
    if i % 48 == 0:
        print('frame', i, 'done', flush=True)

ss = [r['ssim'] for r in rows]
pp = [r['psnr_db'] for r in rows]
out = {
    'frames': '0-185 (map only; cut to phone footage is frame 186, 7.75s)',
    'n': len(rows),
    'mean_ssim': round(sum(ss)/len(ss), 4),
    'mean_psnr_db': round(sum(pp)/len(pp), 2),
    'below_0.90': sum(1 for x in ss if x < 0.90),
    'below_0.85': sum(1 for x in ss if x < 0.85),
    'worst_5': sorted(rows, key=lambda r: r['ssim'])[:5],
    'per_second': {},
}
for s in range(8):
    rs = [r for r in rows if r['frame']//24 == s]
    if rs:
        out['per_second'][str(s)] = {
            'mean_ssim': round(sum(r['ssim'] for r in rs)/len(rs), 4),
            'mean_psnr_db': round(sum(r['psnr_db'] for r in rs)/len(rs), 2),
            'n': len(rs),
        }
json.dump(out, open('verify-seg4/evidence/work/full-192/map-only-means.json', 'w'), indent=1)
print(json.dumps(out, indent=1))
