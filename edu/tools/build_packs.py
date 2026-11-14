"""Đóng gói Kho Data Sẵn thành edu/js/data/catalog.js.

- Chặng 1: để dạng rõ (FREE 100%).
- Chặng 2 + 3: mã hóa AES-256-GCM bằng khóa nội dung (CEK) ngẫu nhiên; CEK được bọc
  bằng KEK = PBKDF2-HMAC-SHA256(license key, salt, 210k vòng) cho từng license key
  (mỗi key một "khe"). Trình duyệt giải mã bằng Web Crypto API (js/core/vault.js).

Chạy:  python edu/tools/build_packs.py
License key nằm ở tools/nguon-bo-de/license-keys.local.json (tự sinh nếu thiếu).
KHÔNG deploy thư mục tools/ lên hosting: nó chứa đề gốc dạng rõ và danh sách key.
"""
import base64
import json
import os
import secrets
import sys

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

ITER = 210_000
HERE = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(HERE, 'nguon-bo-de')
KEYS_FILE = os.path.join(SRC_DIR, 'license-keys.local.json')
OUT_FILE = os.path.join(HERE, '..', 'js', 'data', 'catalog.js')
KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

BLOCKS = [
    {'id': 'it', 'name': 'Khối IT / Kỹ thuật phần mềm'},
    {'id': 'biz', 'name': 'Khối Kinh tế'},
    {'id': 'general', 'name': 'Khối Môn chung'},
    {'id': 'lang', 'name': 'Khối Ngoại ngữ'},
]

SOON = [
    ('prf192', 'PRF192', 'Programming Fundamentals (C)', 'it'),
    ('pro192', 'PRO192', 'Object-Oriented Programming (Java)', 'it'),
    ('csd201', 'CSD201', 'Data Structures & Algorithms', 'it'),
    ('dbi202', 'DBI202', 'Database Systems', 'it'),
    ('prj301', 'PRJ301', 'Java Web Application Development', 'it'),
    ('swp391', 'SWP391', 'Software Development Project', 'it'),
    ('mkt101', 'MKT101', 'Marketing Principles', 'biz'),
    ('eco111', 'ECO111', 'Microeconomics', 'biz'),
    ('fin202', 'FIN202', 'Principles of Corporate Finance', 'biz'),
    ('obm101', 'OBM101', 'Organizational Behavior', 'biz'),
    ('ssg104', 'SSG104', 'Communication & In-Group Working Skills', 'general'),
    ('mas291', 'MAS291', 'Statistics & Probability', 'general'),
    ('trans1', 'TRANS 1', 'Translation 1', 'lang'),
    ('trans2', 'TRANS 2', 'Translation 2', 'lang'),
    ('trans3', 'TRANS 3', 'Translation 3', 'lang'),
    ('ielts', 'IELTS', 'IELTS Foundation Vocabulary', 'lang'),
]


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode('ascii')


def norm_key(k: str) -> str:
    return ''.join(ch for ch in k.upper() if ch.isalnum())


def new_key() -> str:
    return 'EDU-' + '-'.join(''.join(secrets.choice(KEY_ALPHABET) for _ in range(4)) for _ in range(3))


def derive_kek(key: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER)
    return kdf.derive(norm_key(key).encode('utf-8'))


def to_item(raw: dict, pack: dict, stage: int, idx: int) -> dict:
    base = {
        'id': f"{pack['id']}-{stage}-{idx:03d}",
        'checkpoint': stage,
        'group': pack['code'],
        'keywords': raw.get('k', []),
    }
    if pack['type'] == 'mcq':
        base.update({
            'type': 'mcq',
            'questionOrWord': raw['q'],
            'options': raw['o'],
            'answerOrMeaning': raw['a'],
            'explanationOrExample': raw.get('e', ''),
        })
    else:
        base.update({
            'type': 'vocab',
            'questionOrWord': raw['w'],
            'wordType': raw.get('t', ''),
            'ipa': raw.get('ipa', ''),
            'answerOrMeaning': raw['m'],
            'explanationOrExample': raw.get('ex', ''),
            'exampleVi': raw.get('vi', ''),
        })
        if raw['w'] not in base['keywords']:
            base['keywords'] = [raw['w']] + base['keywords']
    return base


def encrypt_locked(pack_id: str, items: list, keys: list) -> dict:
    aad = f'eduone-pack:{pack_id}'.encode('utf-8')
    cek = AESGCM.generate_key(bit_length=256)
    iv = secrets.token_bytes(12)
    payload = json.dumps(items, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    ct = AESGCM(cek).encrypt(iv, payload, aad)
    slots = []
    for k in keys:
        salt = secrets.token_bytes(16)
        siv = secrets.token_bytes(12)
        wk = AESGCM(derive_kek(k, salt)).encrypt(siv, cek, aad)
        slots.append({'salt': b64(salt), 'iv': b64(siv), 'wk': b64(wk)})
    secrets.SystemRandom().shuffle(slots)
    return {'v': 1, 'kdf': 'PBKDF2-SHA256', 'iter': ITER, 'aad': aad.decode('utf-8'), 'iv': b64(iv), 'ct': b64(ct), 'slots': slots}


def main() -> int:
    keys_db = {}
    if os.path.exists(KEYS_FILE):
        with open(KEYS_FILE, encoding='utf-8') as f:
            keys_db = json.load(f)

    packs = []
    for name in sorted(os.listdir(SRC_DIR)):
        if not name.endswith('.json') or name.startswith('license-keys'):
            continue
        with open(os.path.join(SRC_DIR, name), encoding='utf-8') as f:
            src = json.load(f)
        stages = src['stages']
        free = [to_item(r, src, 1, i + 1) for i, r in enumerate(stages.get('1', []))]
        locked_items = []
        for st in ('2', '3'):
            locked_items += [to_item(r, src, int(st), i + 1) for i, r in enumerate(stages.get(st, []))]
        keys = keys_db.get(src['id']) or [new_key() for _ in range(3)]
        keys_db[src['id']] = keys
        pack = {
            'id': src['id'], 'code': src['code'], 'name': src['name'], 'block': src['block'],
            'type': src['type'], 'desc': src.get('desc', ''), 'status': 'ready',
            'stages': [
                {'n': 1, 'count': len(free), 'free': True},
                {'n': 2, 'count': len(stages.get('2', []))},
                {'n': 3, 'count': len(stages.get('3', []))},
            ],
            'total': len(free) + len(locked_items),
            'free': free,
            'locked': encrypt_locked(src['id'], locked_items, keys) if locked_items else None,
        }
        packs.append(pack)
        print(f"[ok] {src['code']}: chặng 1 = {len(free)} (free), chặng 2+3 = {len(locked_items)} (mã hóa, {len(keys)} key)")

    ready_ids = {p['id'] for p in packs}
    for pid, code, title, block in SOON:
        if pid not in ready_ids:
            packs.append({'id': pid, 'code': code, 'name': title, 'block': block, 'status': 'soon'})

    catalog = {'version': 1, 'blocks': BLOCKS, 'packs': packs}
    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, 'w', encoding='utf-8', newline='\n') as f:
        f.write('/* File sinh tự động bởi tools/build_packs.py — không sửa tay. Chặng 2–3 đã mã hóa AES-GCM. */\n')
        f.write('(function (EDU) {\n    EDU.Catalog = ')
        f.write(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')))
        f.write(';\n})(window.EDU = window.EDU || {});\n')

    with open(KEYS_FILE, 'w', encoding='utf-8') as f:
        json.dump(keys_db, f, ensure_ascii=False, indent=2)

    print('\nLicense key (chỉ phát cho người ủng hộ, không commit):')
    for pid, ks in keys_db.items():
        print(f'  {pid}: ' + ', '.join(ks))
    print(f'\n→ {os.path.relpath(OUT_FILE)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
