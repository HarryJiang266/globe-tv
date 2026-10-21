# -*- coding: utf-8 -*-
"""把频道定位到「电视台的实际位置」。

数据源现实（2026-10-19 实测）：
- iptv-org 的 channels.json **没有城市字段**，只有 country / network / owners / website；
- Wikidata / Wikipedia / Nominatim / Overpass 在本机网络下全部访问不到
  （代理 502 / SSL 握手超时），只有 GeoNames 的城市坐标库可用。
所以这里用三级策略，能确定的精确定位，确定不了的交给调用方撒点：

  1. 城市级：从频道名 / 别名里解析出城市名 -> GeoNames 城市坐标（该台就在那座城市）
  2. 机构级：network / owners 命中「广播机构 -> 总部城市」映射表 -> 总部城市坐标
  3. 虚拟级：Pluto / Roku 这类 FAST 网络频道没有实体台址，直接放弃定位

用户已确认取舍：虚拟频道不强行安家（否则上千个 Pluto 频道会全挤在洛杉矶），
无法定位的频道保留原来的国家内撒点。

⚠️ 映射表靠人工维护，新增机构时在 ORG_CITY 里加一行即可，
   城市名交给 GeoNames 查坐标，不用手填经纬度。
"""
import io
import math
import os
import random
import re
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get('GLOBETV_CACHE') or os.path.join(ROOT, '.globetv-cache')

# ---------------------------------------------------------------- 城市库
# cities5000：人口 >= 5000 的城市，约 5 万条，够覆盖地方台所在的中小城市
CITIES_ZIP = os.path.join(CACHE, 'cities5000.zip')
FALLBACK_ZIP = os.path.join(CACHE, 'cities15000.zip')


def _read_cities(path):
    out = []
    with zipfile.ZipFile(path) as z:
        with z.open(os.path.basename(path).replace('.zip', '.txt')) as f:
            for line in io.TextIOWrapper(f, encoding='utf-8'):
                p = line.rstrip('\n').split('\t')
                if len(p) < 15:
                    continue
                try:
                    pop = int(p[14] or 0)
                except ValueError:
                    pop = 0
                out.append((p[1], p[8], float(p[4]), float(p[5]), pop))
    return out


def _build_index(cities):
    """{(cc, name_lower): (lat, lon, pop, display)}"""
    idx = {}
    for name, cc, lat, lon, pop in cities:
        key = (cc, name.lower())
        cur = idx.get(key)
        if cur is None or pop > cur[2]:
            idx[key] = (lat, lon, pop, name)
    return idx


def load_cities():
    path = CITIES_ZIP if os.path.exists(CITIES_ZIP) else FALLBACK_ZIP
    if not os.path.exists(path):
        raise SystemExit('缺少城市库：%s（先跑 probe 下载 cities5000.zip）' % path)
    cities = _read_cities(path)
    idx = _build_index(cities)
    # 按国家分组、长名优先，匹配时先试长名（"New York" 优先于 "York"）
    by_cc = {}
    for (cc, nm), (lat, lon, pop, disp) in idx.items():
        by_cc.setdefault(cc, []).append((nm, lat, lon, pop, disp))
    for cc in by_cc:
        by_cc[cc].sort(key=lambda t: (-len(t[0]), -t[3]))
    return idx, by_cc


# 名称解析用的最小城市人口。放宽到 5000（cities5000）时误报很凶：
# "Anthony Bourdain" 会被当成堪萨斯的小城 Anthony，"30A Golf Kingdom" 之类
# 也会撞上一堆同名小地方。15000 以上基本是真正有人听说过的城市。
MIN_POP_MATCH = 15000

_CITY_IDX = None          # 全量索引：机构表查城市用
_CITY_MATCH = None        # 人口达标的索引：频道名解析用


def _ensure():
    global _CITY_IDX, _CITY_MATCH
    if _CITY_IDX is None:
        _CITY_IDX, _ = load_cities()
        _CITY_MATCH = {(cc, nm): v for (cc, nm), v in _CITY_IDX.items()
                       if v[2] >= MIN_POP_MATCH}
    return _CITY_IDX, _CITY_MATCH


def city_coord(name, cc):
    """城市名 -> (lat, lon, 显示名)，找不到返回 None。"""
    idx, _ = _ensure()
    got = idx.get((cc, name.lower()))
    if got:
        return got[0], got[1], got[3]
    return None


# ---------------------------------------------------------------- 虚拟频道
# 这些是 FAST（免费广告支持流媒体）/ 纯网络频道，没有实体台址。
# 命中就不要硬给它安一个"实际位置"。
FAST_ORG = [
    'pluto',            # Pluto TV，一家 860 个频道
    'roku',             # Roku Channel
    'samsung tv plus',
    'xumo',
    'plex',
    'stirr',
    'local now',
    'haystack',
    'distro tv',
    'zeam',
    'tubi',
    'philo',
    'fubo',
    'sling',
    'rakuten tv',
    'megogo',
    'vimn nordic',      # Viacom 北欧，基本是 Pluto 的瑞典版
    'paramount skydance',
    'paramount global',
    'viacom international',
    'skydance corporation',
]
# 命中这些关键词但频道还有真实 network 字段时，以 network 为准（CBS / Nick 等是真实网）
_NOT_FAST_IF_NETWORK = {'paramount skydance', 'paramount global', 'viacom international',
                        'skydance corporation', 'vimn nordic'}


def is_fast(orgs):
    """orgs 是 (network, [owners]) 或字符串列表。这里只做关键词包含判断。"""
    return _fast_reason(orgs) is not None


def _fast_reason(network, owners):
    net = (network or '').lower()
    ows = [o.lower() for o in (owners or [])]
    for kw in FAST_ORG:
        hit_net = kw in net
        hit_own = any(kw in o for o in ows)
        if not (hit_net or hit_own):
            continue
        # Paramount 系：旗下既有 Pluto 虚拟频道，也有 CBS / Nick 这类真实网络
        if kw in _NOT_FAST_IF_NETWORK and net:
            continue
        return kw
    return None


# ---------------------------------------------------------------- 机构 -> 总部城市
# (关键词小写, 限定国家 or None) -> (城市名, 国家)；城市名交给 GeoNames 查坐标
ORG_CITY = [
    # ---------- 印度（频道数第二多）
    ('doordarshan', 'IN', 'New Delhi', 'IN'),
    ('prasar bharati', 'IN', 'New Delhi', 'IN'),
    ('government of india', 'IN', 'New Delhi', 'IN'),
    ('india today group', 'IN', 'New Delhi', 'IN'),
    ('ndtv', 'IN', 'New Delhi', 'IN'),
    ('new delhi television', 'IN', 'New Delhi', 'IN'),
    ('aastha', 'IN', 'New Delhi', 'IN'),
    ('jiostar', 'IN', 'Mumbai', 'IN'),
    ('reliance industries', 'IN', 'Mumbai', 'IN'),
    ('network18', 'IN', 'Mumbai', 'IN'),
    ('culver max', 'IN', 'Mumbai', 'IN'),
    ('sony pictures networks india', 'IN', 'Mumbai', 'IN'),
    ('zee entertainment', 'IN', 'Mumbai', 'IN'),
    ('zee media', 'IN', 'Mumbai', 'IN'),
    ('essel group', 'IN', 'Mumbai', 'IN'),
    ('times network', 'IN', 'Mumbai', 'IN'),
    ('bennett coleman', 'IN', 'Mumbai', 'IN'),
    ('the epic company', 'IN', 'Mumbai', 'IN'),
    ('9x media', 'IN', 'Mumbai', 'IN'),
    ('mantaro network', 'IN', 'Mumbai', 'IN'),
    ('sanskar info', 'IN', 'Mumbai', 'IN'),
    ('kalaignar', 'IN', 'Chennai', 'IN'),
    ('raj television', 'IN', 'Chennai', 'IN'),
    ('sun gemini', 'IN', 'Chennai', 'IN'),
    ('sun', 'IN', 'Chennai', 'IN'),
    ('etv', 'IN', 'Hyderabad', 'IN'),
    ('eenadu television', 'IN', 'Hyderabad', 'IN'),
    ('tv9', 'IN', 'Hyderabad', 'IN'),
    ('abp', 'IN', 'Kolkata', 'IN'),
    ('associated broadcasting', 'IN', 'Kolkata', 'IN'),
    ('asianet', 'IN', 'Thiruvananthapuram', 'IN'),
    ('malayala manorama', 'IN', 'Kottayam', 'IN'),
    ('odisha television', 'IN', 'Bhubaneswar', 'IN'),
    ('ptc network', 'IN', 'Chandigarh', 'IN'),
    # ---------- 美国
    ('cbs broadcasting', 'US', 'New York City', 'US'),
    ('cbs news and stations', 'US', 'New York City', 'US'),
    ('cbs news', 'US', 'New York City', 'US'),
    ('cbs sports', 'US', 'New York City', 'US'),
    ('cbs entertainment', 'US', 'New York City', 'US'),
    ('nbcuniversal', 'US', 'New York City', 'US'),
    ('nbc', 'US', 'New York City', 'US'),
    ('cable news network', 'US', 'Atlanta', 'US'),
    ('fox corporation', 'US', 'New York City', 'US'),
    ('fox sports', 'US', 'Los Angeles', 'US'),
    ('hearst communications', 'US', 'New York City', 'US'),
    ('the e.w. scripps company', 'US', 'Cincinnati', 'US'),
    ('scripps networks', 'US', 'Knoxville', 'US'),
    ('pbs', 'US', 'Arlington', 'US'),
    ('3abn', 'US', 'West Frankfort', 'US'),
    ('loma linda broadcasting', 'US', 'Loma Linda', 'US'),
    ('llbn', 'US', 'Loma Linda', 'US'),
    ('a+e global media', 'US', 'New York City', 'US'),
    ('a+e networks', 'US', 'New York City', 'US'),
    ('amc networks', 'US', 'New York City', 'US'),
    ('amc global media', 'US', 'New York City', 'US'),
    ('lionsgate studios', 'US', 'Santa Monica', 'US'),
    ('starz', 'US', 'Santa Monica', 'US'),
    ('hbo', 'US', 'New York City', 'US'),
    ('filmrise', 'US', 'New York City', 'US'),
    ('qurate retail', 'US', 'Englewood', 'US'),
    ('altice usa', 'US', 'Bethpage', 'US'),
    ('comcast', 'US', 'Philadelphia', 'US'),
    ('the walt disney company', 'US', 'Burbank', 'US'),
    ('disney channels', 'US', 'Burbank', 'US'),
    # 跨国集团只在总部所在国套用总部城市，其余国家用本地分支（不知道就不定位，
    # 交给城市加权兜底）。早期版本不限国家，把 44 个印度 Disney 频道全扔到了
    # 美国 Burbank，一眼假。
    ('the walt disney company', 'IN', 'Mumbai', 'IN'),
    ('the walt disney company', 'UK', 'London', 'UK'),
    ('star sports', 'IN', 'Mumbai', 'IN'),
    ('sony sports network', 'IN', 'Mumbai', 'IN'),
    ('ewtn', 'US', 'Irondale', 'US'),
    ('espn', 'US', 'Bristol', 'US'),
    ('news12', 'US', 'Woodbury', 'US'),
    ('willow', 'US', 'New York City', 'US'),
    # ---------- 中国 / 港澳台
    ('china central television', 'CN', 'Beijing', 'CN'),
    ('china media group', 'CN', 'Beijing', 'CN'),
    ('china global television network', 'CN', 'Beijing', 'CN'),
    ('jiangsu broadcasting corporation', 'CN', 'Nanjing', 'CN'),
    ('rthk', 'HK', 'Hong Kong', 'HK'),
    ('taiwan broadcasting system', 'TW', 'Taipei', 'TW'),
    ('tvbs', 'TW', 'Taipei', 'TW'),
    ('cna', 'TW', 'Taipei', 'TW'),
    ('icrt', 'TW', 'Taipei', 'TW'),
    ('korean broadcasting system', 'KR', 'Seoul', 'KR'),
    ('mbc chungbuk', 'KR', 'Cheongju', 'KR'),
    ('obs', 'KR', 'Bucheon', 'KR'),
    ('animax', 'KR', 'Seoul', 'KR'),
    ('aniplus', 'KR', 'Seoul', 'KR'),
    # ---------- 俄罗斯 / 独联体
    ('vgtrk', 'RU', 'Moscow', 'RU'),
    ('вгтрк', 'RU', 'Moscow', 'RU'),
    ('gazprom media', 'RU', 'Moscow', 'RU'),
    ('gazprom-media', 'RU', 'Moscow', 'RU'),
    ('national media group', 'RU', 'Moscow', 'RU'),
    ('red media', 'RU', 'Moscow', 'RU'),
    ('sts media', 'RU', 'Moscow', 'RU'),
    ('bridge media', 'RU', 'Moscow', 'RU'),
    ('digital telefamily', 'RU', 'Moscow', 'RU'),
    ('media telecom', 'RU', 'Moscow', 'RU'),
    ('interramedia', 'RU', 'Moscow', 'RU'),
    ('government of the russian federation', 'RU', 'Moscow', 'RU'),
    ('rt', 'RU', 'Moscow', 'RU'),
    ('national state television and radio company', 'BY', 'Minsk', 'BY'),
    ('1+1 media group', 'UA', 'Kyiv', 'UA'),
    ('inter media group', 'UA', 'Kyiv', 'UA'),
    ('viasat ukraine', 'UA', 'Kyiv', 'UA'),
    ('music television of ukraine', 'UA', 'Kyiv', 'UA'),
    ('state committee of turkmenistan', 'TM', 'Ashgabat', 'TM'),
    # ---------- 欧洲
    ('bbc', 'UK', 'London', 'UK'),
    ('bbc television', 'UK', 'London', 'UK'),
    ('amc networks international uk', 'UK', 'London', 'UK'),
    ('skydance emea', 'UK', 'London', 'UK'),
    ('viasat world', 'UK', 'London', 'UK'),
    ('rtve', 'ES', 'Madrid', 'ES'),
    ('tve', 'ES', 'Madrid', 'ES'),
    ('corporació catalana', 'ES', 'Barcelona', 'ES'),
    ('3cat', 'ES', 'Barcelona', 'ES'),
    ('love tv channels', 'ES', 'Madrid', 'ES'),
    ('rai', 'IT', 'Rome', 'IT'),
    ('mfe - mediaforeurope', 'IT', 'Milan', 'IT'),
    ('mediaset', 'IT', 'Milan', 'IT'),
    ('rtl group', 'LU', 'Luxembourg', 'LU'),
    ('ard', 'DE', 'Berlin', 'DE'),
    ('orf', 'AT', 'Vienna', 'AT'),
    ('telewizja polska', 'PL', 'Warsaw', 'PL'),
    ('tvp', 'PL', 'Warsaw', 'PL'),
    ('cyfrowy polsat', 'PL', 'Warsaw', 'PL'),
    ('telewizja polsat', 'PL', 'Warsaw', 'PL'),
    ('telewizja btb', 'PL', 'Warsaw', 'PL'),
    ('tv2 média csoport', 'HU', 'Budapest', 'HU'),
    ('ftv prima', 'CZ', 'Prague', 'CZ'),
    ('cme pro', 'CZ', 'Prague', 'CZ'),
    ('televiziunea română', 'RO', 'Bucharest', 'RO'),
    ('antena group', 'RO', 'Bucharest', 'RO'),
    ('pro tv', 'RO', 'Bucharest', 'RO'),
    ('nova broadcasting', 'BG', 'Sofia', 'BG'),
    ('radio televizija srbije', 'RS', 'Belgrade', 'RS'),
    ('rádio e televisão de portugal', 'PT', 'Lisbon', 'PT'),
    ('euronews', 'FR', 'Lyon', 'FR'),
    ('altice média', 'FR', 'Paris', 'FR'),
    ('persiana media group', 'FR', 'Paris', 'FR'),
    ('radio monte carlo', 'MC', 'Monaco', 'MC'),
    ('spi international', 'NL', 'Hilversum', 'NL'),
    ('ert', 'GR', 'Athens', 'GR'),
    ('stingray group', 'CA', 'Montreal', 'CA'),
    # ---------- 拉美
    ('televisa', 'MX', 'Mexico City', 'MX'),
    ('televisión azteca', 'MX', 'Mexico City', 'MX'),
    ('tv azteca', 'MX', 'Mexico City', 'MX'),
    ('albavisión méxico', 'MX', 'Mexico City', 'MX'),
    ('vb media queretaro', 'MX', 'Querétaro', 'MX'),
    ('tvmás', 'MX', 'Mexico City', 'MX'),
    ('grupo multimedios', 'MX', 'Monterrey', 'MX'),
    ('rcn televisión', 'CO', 'Bogotá', 'CO'),
    ('organización ardila lülle', 'CO', 'Bogotá', 'CO'),
    ('citytv', 'CO', 'Bogotá', 'CO'),
    ('rtvc sistema de medios públicos', 'CO', 'Bogotá', 'CO'),
    ('rede tv!', 'BR', 'São Paulo', 'BR'),
    ('sistema brasileiro de televisão', 'BR', 'São Paulo', 'BR'),
    ('sbt', 'BR', 'São Paulo', 'BR'),
    ('canais sbt', 'BR', 'São Paulo', 'BR'),
    ('tv globo', 'BR', 'Rio de Janeiro', 'BR'),
    ('band', 'BR', 'São Paulo', 'BR'),
    ('rede cnt', 'BR', 'Curitiba', 'BR'),
    ('telefe', 'AR', 'Buenos Aires', 'AR'),
    ('grupo america', 'AR', 'Buenos Aires', 'AR'),
    ('telesur', 'VE', 'Caracas', 'VE'),
    ('nativa tv', 'PE', 'Lima', 'PE'),
    ('grupo atv', 'PE', 'Lima', 'PE'),
    ('red uno', 'BO', 'La Paz', 'BO'),
    ('paceñísima de televisión', 'BO', 'La Paz', 'BO'),
    ('albavisión', 'GT', 'Guatemala City', 'GT'),
    ('radio maya tgba', 'GT', 'Guatemala City', 'GT'),
    ('grupo luksic', 'CL', 'Santiago', 'CL'),
    # ---------- 中东 / 非洲
    ('mbc group', 'SA', 'Riyadh', 'SA'),
    ('saudi broadcasting authority', 'SA', 'Riyadh', 'SA'),
    ('saudi tv', 'SA', 'Riyadh', 'SA'),
    ('shahid', 'SA', 'Riyadh', 'SA'),
    ('al arabiya', 'AE', 'Dubai', 'AE'),
    ('al araby', 'QA', 'Doha', 'QA'),
    ('bein media group', 'QA', 'Doha', 'QA'),
    ('irib', 'IR', 'Tehran', 'IR'),
    ('islamic republic of iran broadcasting', 'IR', 'Tehran', 'IR'),
    ('iraqi media network', 'IQ', 'Baghdad', 'IQ'),
    ('ministry of information', 'KW', 'Kuwait City', 'KW'),
    ('mtv lebanon', 'LB', 'Beirut', 'LB'),
    ('medi1tv', 'MA', 'Tangier', 'MA'),
    ('2m', 'MA', 'Casablanca', 'MA'),
    ('sabc', 'ZA', 'Johannesburg', 'ZA'),
    ('certv', 'SN', 'Dakar', 'SN'),
    # ---------- 亚太其他
    ('vietnam television', 'VN', 'Hanoi', 'VN'),
    ('ho chi minh city television', 'VN', 'Ho Chi Minh City', 'VN'),
    ('vinh long tv', 'VN', 'Vinh Long', 'VN'),
    ('cầnthơ tv', 'VN', 'Can Tho', 'VN'),
    ('mcot', 'TH', 'Bangkok', 'TH'),
    ('distance learning foundation', 'TH', 'Bangkok', 'TH'),
    ('jawa pos multimedia', 'ID', 'Surabaya', 'ID'),
    ('suara surabaya media', 'ID', 'Surabaya', 'ID'),
    ('tvri', 'ID', 'Jakarta', 'ID'),
    ('indonesia network', 'ID', 'Jakarta', 'ID'),
    ('geo television', 'PK', 'Karachi', 'PK'),
    ('ary digital network', 'PK', 'Karachi', 'PK'),
    ('ptv sports network', 'PK', 'Islamabad', 'PK'),
    ('ptv', 'PK', 'Islamabad', 'PK'),
    ('sbs television', 'AU', 'Sydney', 'AU'),
    ('sbs', 'AU', 'Sydney', 'AU'),
    ('network 10', 'AU', 'Sydney', 'AU'),
    ('seven network/foxtel', 'AU', 'Sydney', 'AU'),
    ('abc television', 'AU', 'Sydney', 'AU'),
    ('abc', 'AU', 'Sydney', 'AU'),
    ('trt', 'TR', 'Ankara', 'TR'),
    ('gem group', 'TR', 'Istanbul', 'TR'),
    # ---------- 同名不同国的补一条
    ('abc', 'US', 'New York City', 'US'),
    ('mbc group', 'AE', 'Dubai', 'AE'),
    ('sbs', 'KR', 'Seoul', 'KR'),
    ('etv', 'EE', 'Tallinn', 'EE'),
    ('citytv', 'CA', 'Toronto', 'CA'),
    ('ptv', 'PH', 'Quezon City', 'PH'),
]

# 美国频道名里常写州名而不是城市（"CBS News Minnesota"），
# 州名不在城市库里，补一张「州 -> 该州最大城市」表。
US_STATE = {
    'alabama': 'Birmingham', 'alaska': 'Anchorage', 'arizona': 'Phoenix',
    'arkansas': 'Little Rock', 'california': 'Los Angeles', 'colorado': 'Denver',
    'connecticut': 'Hartford', 'delaware': 'Wilmington', 'florida': 'Miami',
    'georgia': 'Atlanta', 'hawaii': 'Honolulu', 'idaho': 'Boise',
    'illinois': 'Chicago', 'indiana': 'Indianapolis', 'iowa': 'Des Moines',
    'kansas': 'Wichita', 'kentucky': 'Louisville', 'louisiana': 'New Orleans',
    'maine': 'Portland', 'maryland': 'Baltimore', 'massachusetts': 'Boston',
    'michigan': 'Detroit', 'minnesota': 'Minneapolis', 'mississippi': 'Jackson',
    'missouri': 'Kansas City', 'montana': 'Billings', 'nebraska': 'Omaha',
    'nevada': 'Las Vegas', 'new hampshire': 'Manchester', 'new jersey': 'Newark',
    'new mexico': 'Albuquerque', 'new york': 'New York City',
    'north carolina': 'Charlotte', 'north dakota': 'Fargo', 'ohio': 'Columbus',
    'oklahoma': 'Oklahoma City', 'oregon': 'Portland', 'pennsylvania': 'Philadelphia',
    'rhode island': 'Providence', 'south carolina': 'Columbia',
    'south dakota': 'Sioux Falls', 'tennessee': 'Nashville', 'texas': 'Houston',
    'utah': 'Salt Lake City', 'vermont': 'Burlington', 'virginia': 'Virginia Beach',
    'washington': 'Seattle', 'west virginia': 'Charleston', 'wisconsin': 'Milwaukee',
    'wyoming': 'Cheyenne',
}

# 城市名解析时的干扰词：这些"城市名"其实是普通英文单词，匹配上基本是误报
STOP_CITY = {
    'tv', 'radio', 'live', 'hd', 'news', 'channel', 'canal', 'television', 'network',
    'sport', 'sports', 'music', 'movie', 'movies', 'plus', 'one', 'two', 'three', 'four',
    'max', 'national', 'international', 'global', 'world', 'first', 'best', 'top', 'star',
    'sun', 'sky', 'blue', 'gold', 'red', 'green', 'black', 'white', 'free', 'open', 'city',
    'beverly', 'mobile', 'reading', 'nice', 'split', 'most', 'best', 'union', 'liberty',
    'independence', 'fair', 'hope', 'grace', 'faith', 'peace', 'glory', 'victory', 'east',
    'west', 'north', 'south', 'central', 'new', 'old', 'big', 'little', 'grand', 'royal',
    'imperial', 'premium', 'ultra', 'mega', 'super', 'hyper', 'extra', 'direct', 'prime',
    'general', 'universal', 'classic', 'retro', 'modern', 'future', 'today', 'now', 'next',
    'vision', 'action', 'family', 'friends', 'life', 'home', 'style', 'trend', 'zone',
}

WORD_RE = re.compile(r"[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'\-]{2,}")


def find_city_in_text(text, cc, min_len=4):
    """在文本里找该国的城市名（长名优先），返回 (lat, lon, 城市显示名) 或 None。

    实现走 n-gram 反查哈希表：把文本切成词，再从 3 词/2 词/1 词依次去城市索引里查。
    早期版本是"遍历 5 万个城市做正则"，10102 个频道要跑好几分钟，现在几秒。
    """
    if not text or not cc:
        return None
    _, idx = _ensure()          # 第二个是人口达标的索引
    words = WORD_RE.findall(text.lower())
    for n in (3, 2, 1):
        for i in range(len(words) - n + 1):
            gram = ' '.join(words[i:i + n])
            if len(gram) < min_len or gram in STOP_CITY:
                continue
            got = idx.get((cc, gram))
            if got:
                return (got[0], got[1], got[3])
    return None


_CITY_LIST = None


def cities_of_country(cc):
    """该国城市 [(lat, lon, pop, name)]，按人口降序。"""
    global _CITY_LIST
    if _CITY_LIST is None:
        _CITY_LIST = {}
        idx, _ = _ensure()
        for (c, nm), (lat, lon, pop, disp) in idx.items():
            if pop < 5000:
                continue
            _CITY_LIST.setdefault(c, []).append((lat, lon, pop, disp))
        for c in _CITY_LIST:
            _CITY_LIST[c].sort(key=lambda t: -t[2])
    return _CITY_LIST.get(cc, [])


def weighted_alloc(cc, n, exp=0.5, cap=0.25):
    """把 n 个频道按城市人口权重分配到该国城市，返回 [(城市元组, 个数)]。

    exp 控制"多大城市吃多少份额"：1.0 = 完全按人口（印度会有一半挤在孟买/德里），
    0.5 = 开方（仍明显偏向大城市，但中小城市也吃得到份额）。
    cap 限制单城市占比上限，避免东京、开罗这种巨无霸吃掉一个国家。
    """
    cities = cities_of_country(cc)
    if not cities or n <= 0:
        return []
    w = [float(max(c[2], 1)) ** exp for c in cities]
    total = sum(w)
    w = [x / total for x in w]
    # 单城市封顶，多出来的份额按比例摊回其他城市
    for _ in range(3):
        over = sum(max(0.0, x - cap) for x in w)
        if over <= 0:
            break
        keep = [min(x, cap) for x in w]
        rest = [max(0.0, x - cap) for x in w]
        s = sum(rest) or 1.0
        room = sum(max(0.0, cap - x) for x in keep) or 1.0
        w = [k + over * (cap - k) / room if k < cap else k for k in keep]
    counts = [0] * len(cities)
    acc = 0.0
    for i, x in enumerate(w):
        acc += x
        counts[i] = int(acc * n) - sum(counts[:i])
    counts[-1] += n - sum(counts)
    return [(cities[i], counts[i]) for i in range(len(cities)) if counts[i] > 0]


def spread_in_city(lat, lon, n, radius_deg=0.35):
    """把 n 个点以城市中心为圆心环形铺开，返回 [(lon, lat)]。

    radius_deg 是最大半径。0.35° ≈ 39km，在地球直径 500px 的屏幕上约 1px：
    既看得出"这是同一座城市的一批台"，又不会散成一片。
    """
    out = []
    for i in range(n):
        if n == 1:
            rad = th = 0.0
        else:
            rad = radius_deg * math.sqrt((i + 0.5) / n)
            th = i * 2.399963229728653      # 黄金角
        coslat = max(0.15, math.cos(math.radians(lat)))
        out.append((lon + rad * math.cos(th) / coslat, lat + rad * math.sin(th)))
    return out


def city_weighted_points(cc, n, seed=0, radius_deg=0.5):
    """无法精确定位的频道：按城市人口权重落到该国真实城市里。

    比"整个国境内几何均匀撒点"真实得多 —— 电视台不在荒漠里。
    返回 [(lon, lat)]，长度为 n；该国没有城市数据时返回 []（调用方退回原有撒点）。
    """
    alloc = weighted_alloc(cc, n)
    if not alloc:
        return []
    pts = []
    for (lat, lon, pop, name), cnt in alloc:
        pts.extend(spread_in_city(lat, lon, cnt, radius_deg))
    # 打散顺序，避免同一个国家的频道在列表里按城市连续排列
    if seed:
        rnd = random.Random(seed)
        rnd.shuffle(pts)
    return pts


def resolve(network, owners, name, alt_name, cc):
    """返回 (kind, lat, lon, label)：
         kind: 'city' 城市级 / 'org' 机构级 / 'fast' 虚拟频道 / None 无法定位
    """
    net = (network or '').strip()
    ows = [o for o in (owners or []) if o]
    orgs = ([net] if net else []) + ows

    # 1) 城市级：频道名/别名里直接写了城市（这是最可信的"该台在哪儿"）
    got = find_city_in_text(name, cc) or find_city_in_text(alt_name, cc)
    if got:
        return ('city', got[0], got[1], got[2])

    # 1.5) 美国：名字里写的是州名（"CBS News Minnesota"），落到该州最大城市
    if cc == 'US':
        for text in (name, alt_name):
            if not text:
                continue
            for st, city in US_STATE.items():
                if re.search(r'(?<![a-z])' + re.escape(st) + r'(?![a-z])', text.lower()):
                    c = city_coord(city, 'US')
                    if c:
                        return ('city', c[0], c[1], c[2] + ' (' + st + ')')
                    break

    # 2) 虚拟频道：没有实体台址，别硬安家
    kw = _fast_reason(net, ows)
    if kw:
        return ('fast', None, None, kw)

    # 3) 机构级：network / owners 命中总部城市表
    for kw_, cc_limit, city, city_cc in ORG_CITY:
        if city is None:
            continue
        if cc_limit and cc_limit != cc:
            continue
        for o in orgs:
            if kw_ in o.lower():
                c = city_coord(city, city_cc)
                if c:
                    return ('org', c[0], c[1], '%s / %s' % (o, c[2]))
    return (None, None, None, None)
