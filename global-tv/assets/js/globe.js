/* ============================================================
   Globe TV — 3D 地球仪（three.js）
   球体由离线生成的正射贴图渲染，频道亮点用自定义 point shader
   ============================================================ */
(function () {
  'use strict';

  var VERT_EARTH = [
    'varying vec2 vUv;',
    'varying vec3 vN;',
    'void main(){',
    '  vUv = uv;',
    '  vN = normalize(normalMatrix * normal);',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);',
    '}'
  ].join('\n');

  // 光照固定跟随相机（视图空间），地球因此有柔和的明暗过渡
  // uHasMap = 1 时用贴图，= 0 时用 uBase 兜底色（贴图还没到 / 加载失败，
  // 这时绝不能采样成 (0,0,0)，否则地球就是一个黑球）
  var FRAG_EARTH = [
    'uniform sampler2D uMap;',
    'uniform float uHasMap;',
    'uniform vec3 uBase;',
    'uniform vec3 uLight;',
    'uniform float uAmbient;',
    'uniform float uDiffuse;',
    'uniform float uGain;',
    'uniform vec3 uRimColor;',
    'uniform float uRim;',
    'varying vec2 vUv;',
    'varying vec3 vN;',
    'void main(){',
    '  vec3 n = normalize(vN);',
    '  float lam = max(dot(n, normalize(uLight)), 0.0);',
    '  vec3 tex = texture2D(uMap, vUv).rgb;',
    '  vec3 base = mix(uBase, tex, uHasMap) * uGain;',
    '  vec3 col = base * (uAmbient + uDiffuse * pow(lam, 0.85));',
    '  float rim = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.2);',
    '  col += uRimColor * rim * uRim;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var VERT_ATMO = [
    'varying vec3 vN;',
    'void main(){',
    '  vN = normalize(normalMatrix * normal);',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);',
    '}'
  ].join('\n');

  var FRAG_ATMO = [
    'uniform vec3 uColor;',
    'uniform float uPower;',
    'uniform float uStrength;',
    'varying vec3 vN;',
    'void main(){',
    '  float i = pow(max(0.0, 0.80 - dot(normalize(vN), vec3(0.0,0.0,1.0))), uPower);',
    '  gl_FragColor = vec4(uColor * i * uStrength, i * uStrength);',
    '}'
  ].join('\n');

  var VERT_MARK = [
    'attribute float aSize;',
    'attribute float aBright;',
    'attribute float aSeed;',
    'uniform float uTime;',
    'uniform float uPix;',
    'uniform float uScale;',
    'varying float vB;',
    'void main(){',
    '  vec4 mv = modelViewMatrix * vec4(position,1.0);',
    '  gl_Position = projectionMatrix * mv;',
    '  float tw = 0.74 + 0.26 * sin(uTime * 1.45 + aSeed * 6.2831);',
    '  float sz = aSize * uScale * uPix * tw / max(-mv.z, 0.001);',
    '  gl_PointSize = clamp(sz, 1.0, 30.0);',
    '  vB = aBright * tw;',
    '}'
  ].join('\n');

  var FRAG_MARK = [
    'uniform vec3 uColor;',
    'uniform vec3 uHot;',
    'uniform float uOpacity;',
    'varying float vB;',
    'void main(){',
    '  vec2 p = gl_PointCoord - 0.5;',
    '  float d = length(p) * 2.0;',
    '  if (d > 1.0) discard;',
    '  float halo = pow(1.0 - d, 2.8);',
    '  float core = smoothstep(0.58, 0.0, d);',
    '  vec3 col = mix(uColor, uHot, core);',
    '  float a = (halo * 0.46 + core * 1.0) * vB * uOpacity;',
    '  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));',
    '}'
  ].join('\n');

  var VERT_STAR = [
    'attribute float aSize;',
    'attribute float aSeed;',
    'uniform float uTime;',
    'uniform float uPix;',
    'varying float vA;',
    'void main(){',
    '  vec4 mv = modelViewMatrix * vec4(position,1.0);',
    '  gl_Position = projectionMatrix * mv;',
    '  gl_PointSize = aSize * uPix * 0.0022;',
    '  vA = 0.25 + 0.55 * abs(sin(uTime * 0.35 + aSeed * 9.0));',
    '}'
  ].join('\n');

  var FRAG_STAR = [
    'uniform vec3 uColor;',
    'uniform float uAlpha;',
    'varying float vA;',
    'void main(){',
    '  vec2 p = gl_PointCoord - 0.5;',
    '  float d = length(p) * 2.0;',
    '  if (d > 1.0) discard;',
    '  float a = pow(1.0 - d, 2.0) * vA * uAlpha;',
    '  gl_FragColor = vec4(uColor, a);',
    '}'
  ].join('\n');

  /* 说明：为了精确控制画面明暗，这里不使用 three 的 sRGB 输出编码，
     贴图颜色即"最终观感色"，shader 内部按显示空间做乘法。
     ambient/diffuse 的取值要让「未被照亮的一侧」也明显区别于页面底色，
     否则整个半球都是海的时候，地球会被看成一片黑。 */
  var THEME = {
    dark: {
      map: 'assets/img/earth-dark.jpg',
      fallback: [0.17, 0.22, 0.28],       // 贴图未就绪时的兜底球色，绝不渲染成黑洞
      gain: 1.35, ambient: 0.52, diffuse: 0.80, rim: 0.62,
      rimColor: [0.40, 0.88, 0.72],
      /* 亮点配色（实测调优，别随手改）：
         底图调亮之后，若仍用原来的 (0.62,1.0,0.80) 白芯 + 加法混合，
         蓝色通道会被顶到饱和，亮点会从"薄荷绿"退化成"白色/青色"。
         现在降低蓝分量、芯色也不再用纯白，让 60% 的亮点像素仍呈绿色。
         验收：node tools/verify_markers.js <URL>（看"可辨为绿"的占比） */
      mark: [0.24, 1.0, 0.42], hot: [0.66, 1.0, 0.55],
      markOpacity: 0.92,
      markBlend: 'add',
      sprite: { color: 0x62cda8, blend: 'add' },
      atmo: [0.30, 0.72, 0.62], atmoStrength: 0.95,
      star: [0.85, 0.92, 0.98], starAlpha: 0.85
    },
    light: {
      map: 'assets/img/earth-light.jpg',
      fallback: [0.72, 0.77, 0.83],
      gain: 1.0, ambient: 0.74, diffuse: 0.28, rim: 0.35,
      rimColor: [0.06, 0.42, 0.34],
      mark: [0.04, 0.40, 0.28], hot: [0.02, 0.30, 0.20],
      markOpacity: 1.0,
      markBlend: 'normal',
      sprite: { color: 0x0d5c45, blend: 'normal' },
      atmo: [0.10, 0.48, 0.40], atmoStrength: 0.42,
      star: [0.40, 0.46, 0.52], starAlpha: 0.10
    }
  };

  var DEG = Math.PI / 180;

  function smoothstep(a, b, x) {
    var t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  // Preview-only: an original graticule, without coastlines or territory boundaries.
  function makeSchematicTexture(theme) {
    var c = document.createElement('canvas'); c.width = 2048; c.height = 1024;
    var ctx = c.getContext('2d'), dark = theme === 'dark';
    ctx.fillStyle = dark ? '#29363f' : '#c7d3d7'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.strokeStyle = dark ? 'rgba(135,169,171,.14)' : 'rgba(61,87,99,.13)';
    ctx.lineWidth = 1;
    for (var x = 0; x < c.width; x += c.width / 24) {ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,c.height);ctx.stroke();}
    for (var y = 0; y <= c.height; y += c.height / 12) {ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(c.width,y);ctx.stroke();}
    var tex = new THREE.CanvasTexture(c); tex.wrapS = THREE.RepeatWrapping;
    return tex;
  }

  var CONTINENT_LABELS = [
    ['Africa', 4, 20], ['Europe', 51, 17], ['Asia', 40, 86],
    ['North America', 42, -102], ['South America', -18, -58],
    ['Oceania', -23, 139], ['Antarctica', -77, 20]
  ];
  // Visual priority only: not a sovereignty classification. Regions retain qualified names.
  var LARGE_LABELS = 'CN IN RU US CA BR AU AR MX ZA EG DZ CD SA IR TR FR DE ES GB UK IT SE NO FI PL UA KZ ID JP'.split(' ');
  var MEDIUM_LABELS = 'NG ET KE TZ MA LY SD AO MZ MG NA ZM BW PE CL CO VE EC BO PK AF TH VN MY PH KR MN UZ IQ SY JO OM YE NZ RO GR PT HU CZ AT CH BE NL DK IE BY LT LV EE RS BG TN GH CM SN'.split(' ');

  // 触屏（手机/平板）的指针是 coarse，命中区域要放宽
  var COARSE_POINTER = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

  /* 贴图未就绪时的兜底贴图：一个纯色小球色。
     没有它的话，uMap 为 null 时 WebGL 采样返回 (0,0,0)，
     整个地球会渲染成一个黑洞（用户实际遇到过）。 */
  function makeFallbackTexture(rgb) {
    var c = document.createElement('canvas');
    c.width = c.height = 4;
    var g = c.getContext('2d');
    g.fillStyle = 'rgb(' + Math.round(rgb[0] * 255) + ',' + Math.round(rgb[1] * 255) + ',' + Math.round(rgb[2] * 255) + ')';
    g.fillRect(0, 0, 4, 4);
    var t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    return t;
  }

  function makeGlowTexture() {
    var s = 128;
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var g = c.getContext('2d');
    var grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.28, 'rgba(255,255,255,.55)');
    grd.addColorStop(0.55, 'rgba(255,255,255,.14)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    var t = new THREE.CanvasTexture(c);
    return t;
  }

  function makeRingTexture() {
    var s = 128;
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var g = c.getContext('2d');
    g.strokeStyle = 'rgba(255,255,255,.95)';
    g.lineWidth = 4;
    g.beginPath();
    g.arc(s / 2, s / 2, s / 2 - 10, 0, Math.PI * 2);
    g.stroke();
    var grd = g.createRadialGradient(s / 2, s / 2, s * 0.24, s / 2, s / 2, s / 2);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.72, 'rgba(255,255,255,.20)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(c);
  }

  function GlobeView(canvas) {
    this.canvas = canvas;
    this.theme = 'dark';
    this.markers = [];
    this.pos = null;
    this.meta = null;
    this.countries = {};
    this.yaw = -1.920;
    this.pitch = 0.262;
    this.dist = 3.1;
    this.zoomTarget = Math.log(this.dist);
    this.zoomVelocity = 0;
    this.zoomActive = false;
    this._wheelDirection = 0;
    this.target = null;
    this.drag = null;
    this.pinch = null;
    this.vel = { x: 0, y: 0 };
    this.hoverIndex = -1;
    this.selIndex = -1;
    this.hover = null;
    this.pick = null;
    this.hoverScreen = null;
    this._raf = null;
    this._clock = null;
    this._pointers = new Map();
    /* 命中半径（平方，单位是 CSS px²）。
       鼠标光标很细，19.5px 半径够用；手指接触面约 8~10mm，
       手机上必须放大，否则朋友点亮点经常点不中。 */
    this.hitR2 = COARSE_POINTER ? 950 : 380;
    /* 地球仪上画哪些点，可用 URL 参数切（本地对比用）：
         ?places=strict  只画能精确定位到城市的台
         ?places=all     连虚拟网络频道一起画（看旧效果）
       位置等级 p：0 精确定位 / 1 城市加权兜底 / 2 虚拟网络频道 */
    var q = (typeof location !== 'undefined' && location.search) || '';
    this.strictPlaces = /[?&]places=strict\b/.test(q);
    this.showVirtual = /[?&]places=all\b/.test(q);
    /* 亮点绘制参数（世界坐标单位，可调）。
       亮点改成全量后总数上万，尺寸必须随国家密度收缩，
       否则印度、美国这种密区会糊成一块亮片。 */
    this.dot = { base: 0.0160, head: 0.0240, ref: 46, exp: 0.09, min: 0.72, max: 1.0 };
    this._texCache = {};
  }

  GlobeView.prototype.init = function () {
    var self = this;
    var canvas = this.canvas;
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 0);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 400);
    this.camera.position.set(0, 0, this.dist);

    this.group = new THREE.Group();
    this.group.rotation.order = 'XYZ';
    this.scene.add(this.group);

    // ---- 球体
    var t = THEME[this.theme];
    var geo = new THREE.SphereGeometry(1, 128, 84);
    this.earthMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: makeFallbackTexture(t.fallback) },
        uHasMap: { value: 0 },
        uBase: { value: new THREE.Vector3().fromArray(t.fallback) },
        uLight: { value: new THREE.Vector3(-0.42, 0.46, 0.82) },
        uAmbient: { value: t.ambient },
        uDiffuse: { value: t.diffuse },
        uGain: { value: t.gain },
        uRimColor: { value: new THREE.Vector3().fromArray(t.rimColor) },
        uRim: { value: t.rim }
      },
      vertexShader: VERT_EARTH,
      fragmentShader: FRAG_EARTH
    });
    this.earth = new THREE.Mesh(geo, this.earthMat);
    this.group.add(this.earth);

    // ---- 大气辉光
    this.atmoMat = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Vector3().fromArray(t.atmo) },
        uPower: { value: 2.6 },
        uStrength: { value: t.atmoStrength }
      },
      vertexShader: VERT_ATMO,
      fragmentShader: FRAG_ATMO,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.19, 64, 44), this.atmoMat));

    // ---- 星点
    var N = 1100, sp = new Float32Array(N * 3), ss = new Float32Array(N), sd = new Float32Array(N);
    for (var i = 0; i < N; i++) {
      var u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
      var r = 46 + Math.random() * 120, sq = Math.sqrt(1 - u * u);
      sp[i * 3] = r * sq * Math.cos(th);
      sp[i * 3 + 1] = r * u;
      sp[i * 3 + 2] = r * sq * Math.sin(th);
      ss[i] = 0.6 + Math.random() * 2.4;
      sd[i] = Math.random();
    }
    var sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    sg.setAttribute('aSize', new THREE.BufferAttribute(ss, 1));
    sg.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uPix: { value: 900 },
        uColor: { value: new THREE.Vector3().fromArray(t.star) },
        uAlpha: { value: t.starAlpha }
      },
      vertexShader: VERT_STAR, fragmentShader: FRAG_STAR,
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false
    });
    this.stars = new THREE.Points(sg, this.starMat);
    this.scene.add(this.stars);

    // ---- 高亮 / 选中标记
    this.glowTex = makeGlowTexture();
    this.ringTex = makeRingTexture();
    this.hoverSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTex, color: 0xffffff, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
    }));
    this.hoverSprite.visible = false;
    this.selSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.ringTex, color: 0xffffff, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
    }));
    this.selSprite.visible = false;
    this.scene.add(this.hoverSprite);
    this.scene.add(this.selSprite);

    this._bindPointer();
    this._resize();
    window.addEventListener('resize', function () { self._resize(); });
    if (window.ResizeObserver) new ResizeObserver(function () { self._resize(); }).observe(canvas);

    this.loadTexture(this.theme);
    this._clock = new THREE.Clock();
    this._loop();
    return this;
  };

  /* 贴图加载：同一张图只请求一次（init 与 setTheme 会先后调用，之前会重复发两次），
     失败自动重试，并维护 texReady 供启动画面判断。 */
  GlobeView.prototype.loadTexture = function (theme) {
    var self = this;
    var key = THEME[theme].map;

    function apply(tex) {
      tex.anisotropy = Math.min(8, self.renderer.capabilities.getMaxAnisotropy());
      tex.wrapS = THREE.RepeatWrapping;
      self._texCache[key] = tex;
      if (self.earthMat) {
        self.earthMat.uniforms.uMap.value = tex;
        self.earthMat.uniforms.uHasMap.value = 1;
      }
      if (self.theme === theme) {
        self.texReady = true;
        if (self.onTexReady) self.onTexReady(theme, key);
      }
    }

    if (this._texCache[key]) { apply(this._texCache[key]); return; }

    // 正在加载中：把回调挂上去，等同一张图回来，别再发一次请求
    if (this._texLoading && this._texLoading[key]) { this._texLoading[key].push(apply); return; }
    if (!this._texLoading) this._texLoading = {};
    this._texLoading[key] = [apply];

    function finish(tex, err) {
      var cbs = self._texLoading[key] || [];
      delete self._texLoading[key];
      if (tex) {
        for (var i = 0; i < cbs.length; i++) cbs[i](tex);
      } else if (self.theme === theme && self.onTexError) {
        self.onTexError(key, err);
      }
    }

    var attempt = 0;
    var MAX = 3;
    function load() {
      attempt++;
      var loader = new THREE.TextureLoader();
      // file:// 直开时不能给 <img> 带 crossOrigin，否则贴图会被同源策略拦掉
      if (location.protocol === 'file:') loader.crossOrigin = undefined;
      loader.load(key, function (tex) { finish(tex); }, undefined, function (err) {
        if (attempt < MAX) {
          // 网络抖动时重试；每次退避一会儿
          setTimeout(load, 600 * attempt * attempt);
        } else {
          finish(null, err);
        }
      });
    }
    load();
  };

  GlobeView.prototype.setTheme = function (theme) {
    this.theme = theme;
    var t = THEME[theme];
    var key = t.map;
    var blend = t.markBlend === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending;
    this.earthMat.uniforms.uGain.value = t.gain;
    this.earthMat.uniforms.uAmbient.value = t.ambient;
    this.earthMat.uniforms.uDiffuse.value = t.diffuse;
    this.earthMat.uniforms.uRim.value = t.rim;
    this.earthMat.uniforms.uRimColor.value.fromArray(t.rimColor);
    this.earthMat.uniforms.uBase.value.fromArray(t.fallback);
    this.atmoMat.uniforms.uColor.value.fromArray(t.atmo);
    this.atmoMat.uniforms.uStrength.value = t.atmoStrength;
    this.starMat.uniforms.uColor.value.fromArray(t.star);
    this.starMat.uniforms.uAlpha.value = t.starAlpha;
    if (this.hoverSprite) {
      this.hoverSprite.material.blending = blend;
      this.hoverSprite.material.color.setHex(t.sprite.color);
      this.hoverSprite.material.needsUpdate = true;
      this.selSprite.material.blending = blend;
      this.selSprite.material.color.setHex(t.markBlend === 'normal' ? 0x0f8f68 : 0x62cda8);
      this.selSprite.material.needsUpdate = true;
    }
    if (this.markMat) {
      this.markMat.uniforms.uColor.value.fromArray(t.mark);
      this.markMat.uniforms.uHot.value.fromArray(t.hot);
      this.markMat.uniforms.uOpacity.value = t.markOpacity || 1;
      this.markMat.blending = blend;
      this.markMat.needsUpdate = true;
    }
    // 切主题时先退回兜底色，避免"拿旧贴图配新光照参数"的中间态
    var cached = this._texCache[key];
    if (cached) {
      this.loadTexture(theme);
      this.texReady = true;
    } else {
      this.texReady = false;
      this.earthMat.uniforms.uHasMap.value = 0;
      this.loadTexture(theme);
    }
    var self = this;
    requestAnimationFrame(function () { self._resize(); });
  };

  // ------------------------------------------------------------ 标记
  GlobeView.prototype.setData = function (data) {
    this.allChannels = data.channels;
    this.setFilter(null);
  };

  // pred(ch) 返回 false 的频道不参与地球渲染（例如 HTTPS 页面下隐藏只有明文线路的频道）
  GlobeView.prototype.setFilter = function (pred) {
    this.filterPred = pred || null;
    var byCountry = {};
    var list = this.allChannels || [];
    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      if (this.filterPred && !this.filterPred(ch)) continue;
      var p = ch.p || 0;
      // 虚拟网络频道（Pluto / Roku 这类 FAST）没有实体台址，不上地球仪
      if (p === 2 && !this.showVirtual) continue;
      // ?places=strict：只画能精确定位到城市的台，其余（查不到具体位置的）也不画
      if (this.strictPlaces && p !== 0) continue;
      (byCountry[ch.c] || (byCountry[ch.c] = [])).push(ch);
    }
    this.byCountry = byCountry;
    this.selIndex = -1;
    this.hoverIndex = -1;
    if (this.hoverSprite) this.hoverSprite.visible = false;
    if (this.selSprite) this.selSprite.visible = false;
    this.buildMarkers(byCountry);
  };

  // 每个频道一个亮点。原先每国只渲染一部分（合计 2816 个），
  // 用户反馈亮点太少、看不出频道的真实规模，改为全量。
  GlobeView.prototype.dotsFor = function (n) {
    return n;
  };

  GlobeView.prototype.pickChannels = function (arr) {
    var k = this.dotsFor(arr.length);
    if (k >= arr.length) return arr.slice();
    var out = [], step = arr.length / k;
    for (var i = 0; i < k; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  };

  GlobeView.prototype.buildMarkers = function (byCountry) {
    var cc, arr, i, j, count = 0;
    var keys = Object.keys(byCountry);
    var picks = {};
    for (i = 0; i < keys.length; i++) {
      var p = this.pickChannels(byCountry[keys[i]]);
      picks[keys[i]] = p;
      count += p.length;
    }
    var pos = new Float32Array(count * 3);
    var size = new Float32Array(count);
    var bright = new Float32Array(count);
    var seed = new Float32Array(count);
    var meta = new Array(count);
    var n = 0;
    for (i = 0; i < keys.length; i++) {
      cc = keys[i];
      arr = picks[cc];
      var total = byCountry[cc].length;
      var dp = this.dot;
      var dens = Math.max(dp.min, Math.min(dp.max, Math.pow(dp.ref / Math.max(arr.length, 1), dp.exp)));
      var binfo = (this.countries && this.countries[cc]) || {};
      for (j = 0; j < arr.length; j++) {
        var ch = arr[j];
        var la = ch.la * DEG, lo = ch.lo * DEG;
        var cl = Math.cos(la);
        // 与 three.js SphereGeometry 的经纬映射保持一致
        pos[n * 3] = cl * Math.cos(lo) * 1.004;
        pos[n * 3 + 1] = Math.sin(la) * 1.004;
        pos[n * 3 + 2] = -cl * Math.sin(lo) * 1.004;
        var isHead = (j === 0);
        size[n] = (isHead ? dp.head : dp.base) * dens;
        bright[n] = (isHead ? 1.0 : 0.86) * (0.66 + 0.34 * Math.min(1, Math.log(1 + total) / 6.2));
        seed[n] = (n * 0.6180339887) % 1;
        meta[n] = { ch: ch, cc: cc, total: total, head: isHead, info: binfo };
        n++;
      }
    }
    if (this.markerPoints) {
      this.group.remove(this.markerPoints);
      this.markerPoints.geometry.dispose();
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    var t = THEME[this.theme];
    this.markMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uPix: { value: this._pix || 900 }, uScale: { value: 1 },
        uColor: { value: new THREE.Vector3().fromArray(t.mark) },
        uHot: { value: new THREE.Vector3().fromArray(t.hot) },
        uOpacity: { value: t.markOpacity || 1 }
      },
      vertexShader: VERT_MARK, fragmentShader: FRAG_MARK,
      blending: t.markBlend === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending,
      transparent: true, depthWrite: false, depthTest: true
    });
    this.markerPoints = new THREE.Points(g, this.markMat);
    this.markerPoints.frustumCulled = false;
    this.group.add(this.markerPoints);
    this.pos = pos;
    this.meta = meta;
    this.markerCount = count;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
  };

  GlobeView.prototype.setCountries = function (c) {
    this.countries = c;
    this._buildLabels(c);
  };

  GlobeView.prototype._buildLabels = function (countries) {
    if (this.labelLayer) this.labelLayer.remove();
    var layer = document.createElement('div');
    layer.className = 'globe-labels'; layer.setAttribute('aria-hidden', 'true');
    this.canvas.parentNode.appendChild(layer);
    this.labelLayer = layer; this.labels = [];
    var self = this;
    function add(id, name, lat, lon, tier, rank) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      var node = document.createElement('span');
      node.className = 'globe-label ' + (tier < 0 ? 'globe-label-continent' : 'globe-label-country');
      node.textContent = name; node.dataset.label = id; node.style.opacity = '0';
      layer.appendChild(node);
      var la = lat * DEG, lo = lon * DEG;
      self.labels.push({id:id, name:name, tier:tier, rank:rank, node:node,
        point:new THREE.Vector3(Math.cos(la)*Math.cos(lo),Math.sin(la),-Math.cos(la)*Math.sin(lo)).multiplyScalar(1.003),
        alpha:0, desired:0, box:null, width:0, height:0});
    }
    CONTINENT_LABELS.forEach(function (c, i) {add('continent-' + i,c[0],c[1],c[2],-1,i);});
    Object.keys(countries).sort().forEach(function (cc, i) {
      var c = countries[cc], tier = LARGE_LABELS.indexOf(cc) >= 0 ? 0 : MEDIUM_LABELS.indexOf(cc) >= 0 ? 1 : 2;
      var names = {HK:'Hong Kong, China',MO:'Macao, China',TW:'Taiwan, China',TR:'Türkiye'};
      add(cc,names[cc] || c.n,c.la,c.lo,tier,100 + tier * 1000 + i);
    });
    this.labels.sort(function (a,b) {return a.rank-b.rank;});
    this._labelVector = new THREE.Vector3();
    this._measureLabels();
    if(document.fonts) document.fonts.ready.then(function(){self._measureLabels();});
  };

  GlobeView.prototype._measureLabels = function () {
    if (!this.labels) return;
    this.labels.forEach(function (l) {l.width=l.node.offsetWidth;l.height=l.node.offsetHeight;});
    this._labelMeasureWidth = this._w;
  };

  GlobeView.prototype._updateLabels = function (dt, now) {
    if (!this.labels) return;
    if (this._labelMeasureWidth !== this._w) this._measureLabels();
    // All fades derive from the rendered distance (not input direction or zoom target).
    var dist = this.dist;
    var levels = [1-smoothstep(2.55,3.10,dist),1-smoothstep(1.92,2.65,dist),1-smoothstep(1.50,2.05,dist)];
    var continentAlpha = smoothstep(2.48,3.18,dist);
    var budget = Math.round((this._w < 600 ? 10 : 16) + (1-smoothstep(1.28,3.1,dist)) * (this._w < 600 ? 20 : 42));
    var pad = 7, width=this._w, height=this._h, v=this._labelVector;
    function intersects(a,b) {return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;}
    if (!this._labelUiAt || now-this._labelUiAt > 100) {
      this._labelUiAt=now; this._labelUi=[];
      var self=this;
      document.querySelectorAll('.topbar,.hud,.zoomctl,.drawer.is-open,.player:not([hidden]),.tip:not([hidden]),.suggest:not([hidden]),.preview-badge').forEach(function (node) {
        var r=node.getBoundingClientRect(); if(r.width && r.height) self._labelUi.push({left:r.left-pad,right:r.right+pad,top:r.top-pad,bottom:r.bottom+pad});
      });
    }
    var occupied=this._labelUi.slice(), count=0;
    for(var i=0;i<this.labels.length;i++) {
      var l=this.labels[i]; l.desired=0; l.box=null;
      var base=l.tier < 0 ? continentAlpha : levels[l.tier];
      if(base < .005 && l.alpha < .005) continue;
      v.copy(l.point).applyMatrix4(this.group.matrixWorld);
      var facing=(v.z*this.dist-v.lengthSq()) / v.distanceTo(this.camera.position);
      var edge=smoothstep(.02,.30,facing);
      if(edge <= 0) {l.alpha=0;l.node.style.opacity='0';continue;}
      v.project(this.camera);
      var x=(v.x*.5+.5)*width, y=(-v.y*.5+.5)*height;
      var box={left:x-l.width/2-pad,right:x+l.width/2+pad,top:y-l.height/2-pad,bottom:y+l.height/2+pad};
      l.node.style.transform='translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px,0) translate(-50%,-50%)';
      l.box=box;
      if(v.z < -1 || v.z > 1 || box.left<10 || box.right>width-10 || box.top<10 || box.bottom>height-10 || base*edge<.02) continue;
      if(l.tier>=0 && count>=budget) continue;
      var collision=occupied.some(function (r) {return intersects(box,r);});
      if(collision) continue;
      l.desired=base*edge*(l.tier < 0 ? .86 : .90);
      occupied.push(box); if(l.tier>=0) count++;
    }
    // Let outgoing labels clear their space before a colliding newcomer fades in.
    var fading=this.labels.filter(function (l) {return l.desired===0 && l.alpha>.055 && l.box;});
    var inRate=1-Math.exp(-dt/.14), outRate=1-Math.exp(-dt/.085);
    for(var j=0;j<this.labels.length;j++) {
      var item=this.labels[j], goal=item.desired;
      if(goal>item.alpha && item.alpha<.08 && item.box && fading.some(function (l) {return l!==item && intersects(l.box,item.box);})) goal=0;
      item.alpha+=(goal-item.alpha)*(goal>item.alpha?inRate:outRate);
      if(item.alpha<.003) item.alpha=0;
      item.node.style.opacity=item.alpha.toFixed(3);
    }
  };

  // ------------------------------------------------------------ 交互
  GlobeView.prototype._bindPointer = function () {
    var self = this, c = this.canvas;
    function pos(e) {
      var r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    c.addEventListener('pointerdown', function (e) {
      c.setPointerCapture(e.pointerId);
      self._pointers.set(e.pointerId, pos(e));
      if (e.pointerType === 'touch' || e.pointerType === 'pen') self.hitR2 = 950;
      if (self._pointers.size === 1) {
        var p = pos(e);
        self.drag = { x: p.x, y: p.y, moved: 0, t: performance.now(), sx: p.x, sy: p.y };
        self.vel.x = self.vel.y = 0;
        c.classList.add('grabbing');
      } else if (self._pointers.size === 2) {
        var v = Array.from(self._pointers.values());
        self.pinch = {
          d: Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y),
          start: self.dist
        };
        self.drag = null;
      }
    });
    c.addEventListener('pointermove', function (e) {
      var p = pos(e);
      if (self._pointers.has(e.pointerId)) self._pointers.set(e.pointerId, p);
      if (self.pinch && self._pointers.size >= 2) {
        var v = Array.from(self._pointers.values());
        var d = Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y);
        if (self.pinch.d > 8) {
          var ratio = self.pinch.d / Math.max(d, 8);
          self.setDist(self.pinch.start * ratio);
        }
        return;
      }
      if (self.drag) {
        var dx = p.x - self.drag.x, dy = p.y - self.drag.y;
        self.drag.moved += Math.abs(dx) + Math.abs(dy);
        self.drag.x = p.x;
        self.drag.y = p.y;
        self.yaw += dx * 0.0052 * (self.dist / 3.1);
        self.pitch += dy * 0.0052 * (self.dist / 3.1);
        var lim = 84 * DEG;
        if (self.pitch > lim) self.pitch = lim;
        if (self.pitch < -lim) self.pitch = -lim;
        self.vel.x = dx; self.vel.y = dy;
        return;
      }
      // 亮点上万后命中检测不便宜，指针几乎没动就不必重算
      var hl = self._hoverLast;
      if (!hl || Math.abs(p.x - hl.x) + Math.abs(p.y - hl.y) >= 2) {
        self._hoverLast = p;
        self._hoverAt(p.x, p.y);
      }
    });
    function up(e) {
      if (self._pointers.has(e.pointerId)) self._pointers.delete(e.pointerId);
      c.classList.remove('grabbing');
      if (self._pointers.size < 2) self.pinch = null;
      if (self.drag) {
        var p = pos(e);
        var wasDrag = self.drag.moved > 7 || (performance.now() - self.drag.t) > 420;
        if (!wasDrag) {
          var hit = self.hitTest(self.drag.sx, self.drag.sy);
          if (hit >= 0 && self.pick) self.pick(self.meta[hit], hit);
          else if (self.bgPick) self.bgPick();
        }
        self.drag = null;
      }
    }
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', function () {
      if (!self.drag) { self.hoverIndex = -1; self.hoverSprite.visible = false; self._emitHover(-1); }
    });
    c.addEventListener('wheel', function (e) {
      e.preventDefault();
      var delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? self._h : 1);
      if (!Number.isFinite(delta) || delta === 0) return;
      delta = Math.max(-240, Math.min(240, delta));
      var direction = delta < 0 ? -1 : 1;
      // On reversal discard queued distance and velocity, without snapping the camera.
      if (direction !== self._wheelDirection || !self.zoomActive) {
        self.zoomTarget = Math.log(self.dist);
        if (direction !== self._wheelDirection) self.zoomVelocity = 0;
      }
      self._wheelDirection = direction;
      self._queueZoom(self.zoomTarget + delta * 0.0012);
    }, { passive: false });
    c.addEventListener('dblclick', function () { self.reset(); });
  };

  GlobeView.prototype.setDist = function (d) {
    this.dist = Math.max(1.28, Math.min(4.4, d));
    this.zoomTarget = Math.log(this.dist);
    this.zoomVelocity = 0; this.zoomActive = false; this._wheelDirection = 0;
    if (this.target) this.target.zoomInterrupted = true;
  };

  GlobeView.prototype._queueZoom = function (logDistance) {
    this.zoomTarget = Math.max(Math.log(1.28), Math.min(Math.log(4.4), logDistance));
    this.zoomActive = true;
    if (this.target) this.target.zoomInterrupted = true;
  };

  GlobeView.prototype.zoomBy = function (f) {
    var direction=f < 1 ? -1 : 1;
    var base=this.zoomActive && direction===this._wheelDirection ? this.zoomTarget : Math.log(this.dist);
    if(direction!==this._wheelDirection) this.zoomVelocity=0;
    this._wheelDirection=direction;
    this._queueZoom(base + Math.log(f));
  };

  GlobeView.prototype._advanceZoom = function (dt) {
    if (!this.zoomActive) return;
    // Exact critically damped spring in logarithmic distance; stable at variable FPS.
    var x = Math.log(this.dist), offset=x-this.zoomTarget, omega=20;
    var decay=Math.exp(-omega*dt), b=this.zoomVelocity+omega*offset;
    var next=this.zoomTarget+(offset+b*dt)*decay;
    this.zoomVelocity=(this.zoomVelocity-omega*b*dt)*decay;
    if ((this.zoomTarget-x)*(this.zoomTarget-next)<0) {next=this.zoomTarget;this.zoomVelocity=0;}
    this.dist=Math.max(1.28,Math.min(4.4,Math.exp(next)));
    if (Math.abs(next-this.zoomTarget)<.00001 && Math.abs(this.zoomVelocity)<.0003) {
      this.dist=Math.exp(this.zoomTarget);this.zoomVelocity=0;this.zoomActive=false;
    }
  };

  // 旋转到指定经纬度（最短路）
  // 由坐标映射推导：yaw = -(lon + 90°)，pitch = +lat
  GlobeView.prototype.toYaw = function (lon) { return -(lon * DEG + Math.PI / 2); };
  GlobeView.prototype.centerLon = function () { return (-this.yaw - Math.PI / 2) / DEG; };
  GlobeView.prototype.centerLat = function () { return this.pitch / DEG; };

  GlobeView.prototype.focusTo = function (lat, lon, dist, dur) {
    this.zoomTarget = Math.log(this.dist); this.zoomVelocity=0; this.zoomActive=false; this._wheelDirection=0;
    var ty = this.toYaw(lon), tp = lat * DEG;
    var cy = this.yaw;
    var d = ty - cy;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.target = {
      yaw: cy + d, pitch: tp, dist: Math.max(1.3, Math.min(4.4, dist || 2.15)),
      t0: performance.now(), dur: dur || 1000,
      y0: cy, p0: this.pitch, d0: this.dist
    };
  };

  GlobeView.prototype.reset = function () {
    this.focusTo(this.centerLat(), this.centerLon(), 3.1, 900);
  };

  GlobeView.prototype.markSelected = function (meta) {
    if (!meta) { this.selSprite.visible = false; this.selIndex = -1; return; }
    var i = this._findIndex(meta);
    this.selIndex = i;
    if (i >= 0) this._placeSprite(this.selSprite, i, 0.055);
  };

  GlobeView.prototype._findIndex = function (meta) {
    if (!this.meta) return -1;
    for (var i = 0; i < this.meta.length; i++) {
      if (this.meta[i].ch === meta.ch) return i;
    }
    return -1;
  };

  GlobeView.prototype._placeSprite = function (sp, i, scale) {
    var p = this._tmp.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]).applyMatrix4(this.group.matrixWorld);
    var cam = this.camera.position;
    // 转到背面就藏起来
    var dx = cam.x - p.x, dy = cam.y - p.y, dz = cam.z - p.z;
    var front = (p.x * dx + p.y * dy + p.z * dz) > 0.02;
    sp.visible = front;
    if (!front) return;
    sp.position.copy(p);
    sp.scale.setScalar(scale);
  };

  GlobeView.prototype.hitTest = function (mx, my) {
    if (!this.pos) return -1;
    var cam = this.camera, w = this._w, h = this._h;
    var cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
    var em = this.group.matrixWorld.elements;
    /* 亮点上万后，每次鼠标移动都要跑一遍这个循环，
       所以这里手工展开投影：view 与 projection 先乘成一个矩阵，
       每个点只做一次 4x4 乘法，不再逐点 Vector3.project()
       （后者每点要做两次 4x4 乘法，还会新建临时对象）。 */
    if (!this._vp) this._vp = new THREE.Matrix4();
    cam.updateMatrixWorld();
    var vp = this._vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    var best = -1, bestD = this.hitR2;   // 鼠标 ≈19.5px 半径 / 触屏 ≈30.8px
    var pos = this.pos, n = this.markerCount;
    for (var i = 0; i < n; i++) {
      var x0 = pos[i * 3], y0 = pos[i * 3 + 1], z0 = pos[i * 3 + 2];
      var x = em[0] * x0 + em[4] * y0 + em[8] * z0 + em[12];
      var y = em[1] * x0 + em[5] * y0 + em[9] * z0 + em[13];
      var z = em[2] * x0 + em[6] * y0 + em[10] * z0 + em[14];
      // 背面剔除：法线朝向相机
      var dx = cx - x, dy = cy - y, dz = cz - z;
      if (x * dx + y * dy + z * dz <= 0.02) continue;
      var cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
      if (cw <= 0) continue;                // 在相机背后
      var ndx = (vp[0] * x + vp[4] * y + vp[8] * z + vp[12]) / cw;
      var ndy = (vp[1] * x + vp[5] * y + vp[9] * z + vp[13]) / cw;
      var sx = (ndx * 0.5 + 0.5) * w, sy = (-ndy * 0.5 + 0.5) * h;
      var ddx = sx - mx, ddy = sy - my;
      var d = ddx * ddx + ddy * ddy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  GlobeView.prototype._hoverAt = function (mx, my) {
    var i = this.hitTest(mx, my);
    if (i === this.hoverIndex) {
      if (i >= 0) this._placeSprite(this.hoverSprite, i, 0.05);
      return;
    }
    this.hoverIndex = i;
    if (i < 0) {
      this.hoverSprite.visible = false;
      this.canvas.classList.remove('pointing');
    } else {
      this.canvas.classList.add('pointing');
      this._placeSprite(this.hoverSprite, i, 0.05);
    }
    this._emitHover(i, mx, my);
  };

  GlobeView.prototype._emitHover = function (i, mx, my) {
    if (this.hover) this.hover(i < 0 ? null : this.meta[i], i, mx, my);
  };

  // ------------------------------------------------------------ 渲染循环
  GlobeView.prototype._resize = function () {
    var w = this.canvas.clientWidth || window.innerWidth;
    var h = this.canvas.clientHeight || window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._w = w; this._h = h;
    var pix = (h * dpr) / (2 * Math.tan((this.camera.fov * DEG) / 2));
    this._pix = pix;
    if (this.markMat) this.markMat.uniforms.uPix.value = pix;
    if (this.starMat) this.starMat.uniforms.uPix.value = pix;
  };

  GlobeView.prototype._loop = function () {
    var self = this;
    function frame() {
      self._raf = requestAnimationFrame(frame);
      var now = performance.now();
      var time = now / 1000;
      var dt = Math.min(.25, Math.max(.001, (now-(self._lastFrame || now-16.667))/1000));
      self._lastFrame=now;
      self._advanceZoom(dt);

      if (self.target) {
        var tg = self.target;
        var k = Math.min(1, (now - tg.t0) / tg.dur);
        var e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        self.yaw = tg.y0 + (tg.yaw - tg.y0) * e;
        self.pitch = tg.p0 + (tg.pitch - tg.p0) * e;
        if (!tg.zoomInterrupted) {
          self.dist = tg.d0 + (tg.dist - tg.d0) * e;
          self.zoomTarget = Math.log(self.dist);
        }
        if (k >= 1) self.target = null;
      } else if (!self.drag && !self.pinch) {
        // 惯性
        if (Math.abs(self.vel.x) > 0.05 || Math.abs(self.vel.y) > 0.05) {
          self.yaw += self.vel.x * 0.0052 * 0.9 * (self.dist / 3.1);
          self.pitch += self.vel.y * 0.0052 * 0.9 * (self.dist / 3.1);
          var lim = 84 * DEG;
          self.pitch = Math.max(-lim, Math.min(lim, self.pitch));
          self.vel.x *= 0.9;
          self.vel.y *= 0.9;
        }
        // 空闲自转已移除：不拖动时地球停在原处，只保留松手后的惯性滑动
      }

      self.group.rotation.set(self.pitch, self.yaw, 0);
      self.group.updateMatrixWorld();

      if (self.markMat) {
        self.markMat.uniforms.uTime.value = time;
        self.markMat.uniforms.uScale.value = Math.pow(2.7 / self.dist, 0.55);
      }
      if (self.starMat) self.starMat.uniforms.uTime.value = time;

      self.camera.position.z = self.dist;
      self.camera.lookAt(0, 0, 0);
      self.camera.updateMatrixWorld();
      self._updateLabels(dt, now);

      if (self.hoverIndex >= 0) {
        self._placeSprite(self.hoverSprite, self.hoverIndex, 0.05 * Math.min(1.5, 3.1 / self.dist));
        if (self.hoverSprite.visible && self.hoverMove) {
          var hv = self._tmp2.copy(self.hoverSprite.position).project(self.camera);
          self.hoverMove({ x: (hv.x * 0.5 + 0.5) * self._w, y: (-hv.y * 0.5 + 0.5) * self._h });
        }
      }
      if (self.selIndex >= 0) {
        var pulse = 1 + 0.16 * Math.sin(time * 2.4);
        self._placeSprite(self.selSprite, self.selIndex, 0.062 * pulse * Math.min(1.6, 3.1 / self.dist));
      }
      self.renderer.render(self.scene, self.camera);
    }
    this._raf = requestAnimationFrame(frame);
  };

  GlobeView.prototype.stop = function () { if (this._raf) cancelAnimationFrame(this._raf); };

  window.GlobeView = GlobeView;
})();
