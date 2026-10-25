"""Monta server/menu-source.json a partir do cardápio extraído do InstaDelivery.

O InstaDelivery não tinha descrições nem lista de ingredientes, então os ingredientes
são estimados pelo nome do lanche (o dono ajusta pelo painel).
Uso: python3 scripts/build-menu-source.py
"""
import json, re, unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
run1 = json.loads((ROOT / 'scripts/scraped/run1.json').read_text())
images = {}
for f in sorted((ROOT / 'scripts/scraped').glob('images-*.json')):
    for p in json.loads(f.read_text()).get('products', []):
        if p.get('image'):
            images[p['name'].strip().lower()] = p['image']

def norm(s):
    s = unicodedata.normalize('NFD', s.lower())
    return ''.join(c for c in s if unicodedata.category(c) != 'Mn')

def big(url):
    # a versão _75_75 do CDN é a de 400x400 (a sem sufixo é menor, 297x170)
    if not url or 'placeholder' in url or url.endswith('9f6d0a12762cea0252ee2a2c03d11b29.png'):
        return None
    return url

BASE = ['Pão', 'Alface', 'Tomate', 'Maionese da casa']
PROTEINS = [
    ('picanha', 'Hambúrguer de picanha'), ('file', 'Filé'), ('frango', 'Frango desfiado'),
    ('calabresa', 'Calabresa'), ('coracao', 'Coração de frango'), ('toscana', 'Linguiça toscana'),
    ('bacon', 'Bacon'),
]

def burger_ingredients(name, category):
    n = norm(name)
    ing = list(BASE)
    meats = [label for key, label in PROTEINS if key in n]
    if 'picanha' not in n and ('hamburguer' in n or 'burguer' in n or n.startswith('x ') or n in ('eggs', 'americano', 'da casa', 'la chapa', 'garage burger', 'alasanhado', 'barao de ipanema') or 'franburguer' in n):
        meats.insert(0, 'Hambúrguer bovino')
    if 'franpiry' in n:
        meats = ['Frango desfiado', 'Catupiry']
    if 'calafrango' in n:
        meats = ['Calabresa', 'Frango desfiado']
    if 'franburguer' in n:
        meats = ['Hambúrguer bovino', 'Frango desfiado']
    if not meats:
        meats = ['Hambúrguer bovino']
    ing[1:1] = meats
    if n.startswith('x') or 'cheddar' in n or 'especial' in n or n in ('da casa', 'la chapa', 'garage burger', 'alasanhado', 'barao de ipanema', 'calafrango', 'franpiry'):
        ing.insert(1 + len(meats), 'Cheddar' if 'cheddar' in n else 'Queijo mussarela')
    if 'eggs' in n or 'americano' in n or 'especial' in n or n in ('da casa', 'garage burger', 'la chapa'):
        ing.insert(1 + len(meats), 'Ovo')
    if 'alho' in n:
        ing.append('Molho de alho')
    if 'onion' in n:
        ing.append('Anéis de cebola')
    if 'especial' in n or n in ('da casa', 'garage burger', 'barao de ipanema', 'la chapa'):
        ing += ['Presunto', 'Milho', 'Batata palha']
    if 'alasanhado' in n:
        ing += ['Presunto', 'Molho de tomate']
    if n == 'garage burger':
        ing += ['Bacon', 'Calabresa', 'Frango desfiado']
    seen, out = set(), []
    for i in ing:
        if i not in seen:
            seen.add(i); out.append(i)
    return out

BURGER_CATS = ('HAMBÚRGUER DE PICANHA', 'HAMBÚRGUERS TRADICIONAIS')
BURGER_ADDONS = [
    {'name': 'Bacon extra', 'price': '4,00'}, {'name': 'Ovo extra', 'price': '2,00'},
    {'name': 'Cheddar extra', 'price': '3,00'}, {'name': 'Hambúrguer extra', 'price': '5,00'},
    {'name': 'Catupiry', 'price': '3,00'},
]
FIXED = {'Pão', 'Hambúrguer bovino', 'Hambúrguer de picanha'}

CAT_NAMES = {
    'HAMBÚRGUER DE PICANHA': 'Hambúrguer de Picanha', 'HAMBÚRGUERS TRADICIONAIS': 'Hambúrgueres Tradicionais',
    'CACHORRO QUENTE': 'Cachorro-Quente', 'BATATA FRITA': 'Batata Frita', 'REFRIGERANTES': 'Refrigerantes 1L',
    'POLPA C/ LEITE': 'Sucos com Leite', 'POLPA S/ LEITE': 'Sucos sem Leite', 'BOMBA BAIANA': 'Bomba Baiana',
    'REFRIGERANTE EM LATA': 'Refrigerante em Lata',
}
out_cats = []
for c in run1['categories']:
    items = []
    for it in c['items']:
        name = it['name'].strip()
        img = big(it.get('image') or images.get(name.lower()))
        item = {'name': name, 'price': it['price'], 'image': img, 'description': it.get('description') or ''}
        if it.get('original_price') and it['original_price'] != it['price']:
            item['original_price'] = it['original_price']
        if c['name'] in BURGER_CATS:
            ing = burger_ingredients(name, c['name'])
            item['ingredients'] = ing
            item['fixed'] = [i for i in ing if i in FIXED]
            item['addons'] = BURGER_ADDONS
            item['description'] = ', '.join(ing).capitalize() + '.'
        elif c['name'] == 'CACHORRO QUENTE':
            item['ingredients'] = ['Pão', 'Salsicha', 'Molho de tomate', 'Milho', 'Ervilha', 'Batata palha', 'Queijo ralado']
            item['fixed'] = ['Salsicha']
            item['description'] = 'Salsicha no molho, milho, ervilha, batata palha e queijo ralado, servido no prato.'
        elif c['name'] == 'Combos':
            item['description'] = item['description'] or 'Combo com refrigerante Goob 1L.'
        item['featured'] = c['name'] == 'Combos' or name in ('GARAGE BURGER', 'PICANHA DO CHEFF', 'PICANHA CHEDDAR BACON', 'DA CASA')
        items.append(item)
    out_cats.append({'name': CAT_NAMES.get(c['name'], c['name']), 'items': items})

s = run1['store']
src = {
    'store': {
        'name': 'Garage Burger 79', 'tagline': 'Hambúrguer na chapa em Nossa Senhora do Socorro',
        'logo': s.get('logo'), 'banner': s.get('banner'), 'address': 'Nossa Senhora do Socorro - SE',
        'phone': s.get('phone'), 'whatsapp': s.get('phone'), 'hours': 'Todos os dias, 14h às 0h59', 'open': True,
    },
    'delivery': {'fee_cents': 500, 'min_order_cents': 1000, 'eta_min': 30, 'eta_max': 50},
    'categories': out_cats,
}
(ROOT / 'server/menu-source.json').write_text(json.dumps(src, ensure_ascii=False, indent=1))
n = sum(len(c['items']) for c in out_cats)
print(n, 'itens;', sum(1 for c in out_cats for i in c['items'] if i['image']), 'com foto')
