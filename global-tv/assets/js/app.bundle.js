/* Globe TV — 自动生成，请勿直接修改。
   源文件：changelog.js + globe.js + player.js + app.js + boot.js
   重新生成：python tools/bundle.py */
/* ===== changelog.js ===== */
/* ============================================================
   Globe TV — 更新记录
   发版时改这里：
     1. 把 current 改成新的版本号
     2. 在 entries 最前面加一条（最新的放最上面）
   页面会用 current 和用户本地记录的已读版本比对，
   不一致就弹出更新说明，并在右上角按钮上点一个小圆点。

   ⚠️ 这个文件列在 globetv-dev/bundle.py 的 PARTS 里，
      改完必须跑一次 `python bundle.py` 重新打包，否则页面用的还是旧的。
   ============================================================ */
window.TV_CHANGELOG = {
  current: '2026-10-15.2',

  entries: [
    {
      v: '2026-10-15.2',
      date: '2026-10-15',
      title: '去掉极区中央那圈圆环',
      items: [
        '正对南极（或北极）看地球时，极区中央原来有一圈莫名其妙的圆环 —— 它其实是 75° 纬线在球面上的投影。现在经纬网只画到南北纬 60°，极区保持干净。',
        '赤道和低纬地区的经纬网格没有变化。'
      ]
    },
    {
      v: '2026-10-15.1',
      date: '2026-10-15',
      title: '去掉陆地上的网点纹理',
      items: [
        '陆地上原来盖着一层细密的小灰点（每隔 9 像素一个），远看像蒙了层灰纱，凑近了还会和频道亮点混淆。现在去掉了，陆地是干净的纯色块，海岸线和国界看得更清楚。',
        '海洋和陆地的颜色没有改动，跟之前一致。'
      ]
    },
    {
      v: '2026-10-14.2',
      date: '2026-10-14',
      title: '全屏更干净，并加入更新提醒',
      items: [
        '全屏播放时不再在画面正中显示播放三角。要看控制按钮时移动一下鼠标，右下角会出现「暂停 / 退出全屏」，停手两秒自动淡出。',
        '画面里有「正在连接」「点击播放」这类文字提示时，也不再叠出播放三角。',
        '新增更新提醒：以后每次更新都会告诉你改了什么，右上角的更新按钮可以随时翻看完整历史。'
      ]
    },
    {
      v: '2026-10-14.1',
      date: '2026-10-14',
      title: '地球不再自己转，亮点落到陆地上',
      items: [
        '去掉空闲自动旋转：松手后地球就停在原处（拖动时的惯性滑动保留）。',
        '亮点改为按真实国界采样，不再撒到海里 —— 此前约 15% 的坐标落在海上，智利、挪威、印尼这类长条形国家尤其明显。',
        '亮点从 2816 个增加到 8464 个（每个频道一个点），并按所在国家的密度自动调整大小，密区不会糊成一块。',
        '修正地球贴图上两条横穿整幅地图的假线（俄罗斯跨经线导致的），以及南极区域被误画成海洋的问题。'
      ]
    }
  ]
};

/* ===== globe.js ===== */
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

  GlobeView.prototype.setCountries = function (c) { this.countries = c; };

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
      var k = Math.exp(e.deltaY * 0.0012);
      self.setDist(self.dist * k);
    }, { passive: false });
    c.addEventListener('dblclick', function () { self.reset(); });
  };

  GlobeView.prototype.setDist = function (d) {
    this.dist = Math.max(1.28, Math.min(4.4, d));
  };

  GlobeView.prototype.zoomBy = function (f) {
    var self = this, from = this.dist, to = Math.max(1.28, Math.min(4.4, this.dist * f));
    var t0 = performance.now();
    (function step() {
      var k = Math.min(1, (performance.now() - t0) / 320);
      var e = 1 - Math.pow(1 - k, 3);
      self.dist = from + (to - from) * e;
      if (k < 1) requestAnimationFrame(step);
    })();
  };

  // 旋转到指定经纬度（最短路）
  // 由坐标映射推导：yaw = -(lon + 90°)，pitch = +lat
  GlobeView.prototype.toYaw = function (lon) { return -(lon * DEG + Math.PI / 2); };
  GlobeView.prototype.centerLon = function () { return (-this.yaw - Math.PI / 2) / DEG; };
  GlobeView.prototype.centerLat = function () { return this.pitch / DEG; };

  GlobeView.prototype.focusTo = function (lat, lon, dist, dur) {
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

      if (self.target) {
        var tg = self.target;
        var k = Math.min(1, (now - tg.t0) / tg.dur);
        var e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        self.yaw = tg.y0 + (tg.yaw - tg.y0) * e;
        self.pitch = tg.p0 + (tg.pitch - tg.p0) * e;
        self.dist = tg.d0 + (tg.dist - tg.d0) * e;
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

/* ===== player.js ===== */
/* ============================================================
   Globe TV — 播放器
   HLS / 直链播放，线路失效自动切换，失败时给出可操作提示
   ============================================================ */
(function () {
  'use strict';

  // ---------------------------------------------------------- 公共小工具
  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function initials(name) {
    var s = (name || '?').replace(/[^\p{L}\p{N} ]+/gu, ' ').trim();
    var parts = s.split(/\s+/).filter(Boolean);
    if (!parts.length) return 'TV';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  function logoInner(ch) {
    if (ch.o) {
      var img = el('img');
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.alt = '';
      img.onerror = function () {
        if (img.parentNode) img.parentNode.replaceChild(el('span', null, initials(ch.n)), img);
      };
      img.src = ch.o;
      return img;
    }
    return el('span', null, initials(ch.n));
  }
  function logoInto(host, ch) {
    host.innerHTML = '';
    host.appendChild(logoInner(ch));
  }
  function logoEl(ch, cls) {
    var box = el('div', cls || 'logoimg');
    box.appendChild(logoInner(ch));
    return box;
  }
  function fmt(n) { return (n || 0).toLocaleString('en-US'); }
  function ccLabel(cc, info) {
    if (!info) return cc || '';
    return (info.f ? info.f + ' ' : '') + info.n;
  }

  window.TVUtil = { el: el, logoEl: logoEl, logoInto: logoInto, initials: initials, fmt: fmt, ccLabel: ccLabel };

  // ---------------------------------------------------------- 播放器
  var HLS_URL = 'assets/vendor/hls.min.js';
  var hlsState = 0;          // 0 未加载 / 1 加载中 / 2 就绪 / -1 失败
  var hlsQueue = [];

  function needHls(cb) {
    if (window.Hls) { cb(null); return; }
    if (hlsState === -1) { cb(new Error('hls.js 加载失败')); return; }
    hlsQueue.push(cb);
    if (hlsState === 1) return;
    hlsState = 1;
    var s = document.createElement('script');
    s.src = HLS_URL;
    s.onload = function () {
      hlsState = window.Hls ? 2 : -1;
      flush(window.Hls ? null : new Error('hls.js 未就绪'));
    };
    s.onerror = function () { hlsState = -1; flush(new Error('hls.js 加载失败')); };
    document.head.appendChild(s);
  }

  function flush(err) {
    var q = hlsQueue;
    hlsQueue = [];
    for (var i = 0; i < q.length; i++) q[i](err);
  }

  var HLS_OPTS = {
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 30,
    manifestLoadingTimeOut: 11000,
    manifestLoadingMaxRetry: 2,
    levelLoadingTimeOut: 11000,
    fragLoadingTimeOut: 22000,
    fragLoadingMaxRetry: 2
  };

  function Player(opts) {
    this.o = opts || {};
    this.root = document.getElementById('player');
    this.video = document.getElementById('video');
    this.cover = document.getElementById('p-cover');
    this.msg = document.getElementById('p-msg');
    this.msgTitle = document.getElementById('p-msg-title');
    this.msgSub = document.getElementById('p-msg-sub');
    this.msgActions = document.getElementById('p-msg-actions');
    this.spin = document.getElementById('p-spin');
    this.badge = document.getElementById('p-quality');
    this.bigplay = document.getElementById('p-bigplay');
    this.logoBox = document.getElementById('p-logo');
    this.nameBox = document.getElementById('p-name');
    this.metaBox = document.getElementById('p-meta');
    this.sourcesBox = document.getElementById('p-sources');
    this.plBody = document.getElementById('p-pl-body');
    this.plTitle = document.getElementById('p-pl-title');
    this.plFilter = document.getElementById('p-pl-filter');
    this.favBtn = document.getElementById('p-fav');
    this.stage = document.getElementById('stage');
    this.hls = null;
    this.ch = null;
    this.srcIdx = 0;
    this.bad = {};
    this.playlist = [];
    this.timer = null;
    this.tries = 0;
    this.gen = 0;
    this.expectUrl = '';
    this.video.volume = 0.85;
    this._bind();
  }

  Player.prototype._bind = function () {
    var self = this;
    document.getElementById('p-close').addEventListener('click', function () { self.close(); });
    this.bigplay.addEventListener('click', function () {
      if (self.video.paused) self.tryPlay(true); else self.video.pause();
    });
    this.video.addEventListener('pause', function () {
      self.stage.classList.remove('is-playing');
      self.root.classList.remove('is-playing');
      if (document.fullscreenElement) syncFsPlayIcon();
    });
    this.video.addEventListener('play', function () {
      self.stage.classList.add('is-playing');
      self.root.classList.add('is-playing');
      if (document.fullscreenElement) syncFsPlayIcon();
      self.clearTimer();
      self.hideMsg();
      self.o.onStatus && self.o.onStatus('playing', self.ch);
    });
    this.video.addEventListener('playing', function () { self.cover.classList.remove('is-on'); });
    var vol = document.getElementById('p-vol');
    vol.addEventListener('input', function () {
      self.video.volume = parseFloat(vol.value);
      self.video.muted = self.video.volume === 0;
      self._syncMute();
    });
    document.getElementById('p-mute').addEventListener('click', function () {
      self.video.muted = !self.video.muted;
      self._syncMute();
    });
    document.getElementById('p-fs').addEventListener('click', function () {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (self.stage.requestFullscreen) self.stage.requestFullscreen();
    });

    /* 全屏控制条。全屏的是 .stage 本身，外层的控件栏看不到，
       所以暂停 / 退出全屏这两个入口必须放进画面里。
       平时隐藏，鼠标动一下淡入、停手 2.6 秒淡出 —— 这样观看时画面是干净的。 */
    var fsTimer = null;
    function syncFsPlayIcon() {
      var icon = document.getElementById('p-fsplay-icon');
      icon.innerHTML = self.video.paused
        ? '<path d="M8 5.5v13l11-6.5z"/>'
        : '<path d="M8 4.8h3.1v14.4H8zM12.9 4.8H16v14.4h-3.1z"/>';
    }
    function pokeFsCtl() {
      if (!document.fullscreenElement) return;
      self.stage.classList.add('is-ctl');
      clearTimeout(fsTimer);
      fsTimer = setTimeout(function () { self.stage.classList.remove('is-ctl'); }, 2600);
    }
    document.getElementById('p-fsplay').addEventListener('click', function (e) {
      e.stopPropagation();
      if (self.video.paused) self.tryPlay(true); else self.video.pause();
      syncFsPlayIcon();
      pokeFsCtl();
    });
    document.getElementById('p-fsexit').addEventListener('click', function (e) {
      e.stopPropagation();
      if (document.fullscreenElement) document.exitFullscreen();
    });
    this.stage.addEventListener('pointermove', pokeFsCtl);
    document.addEventListener('fullscreenchange', function () {
      if (document.fullscreenElement) { syncFsPlayIcon(); pokeFsCtl(); }
      else { self.stage.classList.remove('is-ctl'); clearTimeout(fsTimer); }
    });
    this.favBtn.addEventListener('click', function () {
      if (!self.ch) return;
      var on = self.o.onToggleFav && self.o.onToggleFav(self.ch);
      self.favBtn.classList.toggle('is-on', !!on);
    });
    this.plFilter.addEventListener('input', function () { self.renderPlaylist(); });
    document.addEventListener('keydown', function (e) {
      if (self.root.hidden) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') self.close();
      if (e.key === ' ') { e.preventDefault(); self.bigplay.click(); }
    });
    this._syncMute();
  };

  Player.prototype._syncMute = function () {
    document.getElementById('p-mute').classList.toggle('is-on', this.video.muted);
  };

  Player.prototype.isOpen = function () { return !this.root.hidden; };

  Player.prototype.open = function (ch, playlist, title) {
    this.root.hidden = false;
    this.root.classList.remove('is-closing');
    document.body.classList.add('has-player');
    if (playlist) { this.playlist = playlist; this.plTitle.textContent = title || '频道列表'; }
    this.setChannel(ch);
  };

  Player.prototype.close = function () {
    var self = this;
    this.stop();
    this.root.classList.add('is-closing');
    document.body.classList.remove('has-player');
    setTimeout(function () {
      self.root.hidden = true;
      self.root.classList.remove('is-closing');
    }, 240);
    this.o.onClose && this.o.onClose();
  };

  Player.prototype.stop = function () {
    this.clearTimer();
    if (this._offErr) { this._offErr(); this._offErr = null; }
    if (this.hls) { try { this.hls.destroy(); } catch (e) { } this.hls = null; }
    try { this.video.pause(); } catch (e) { }
    this.video.removeAttribute('src');
    try { this.video.load(); } catch (e) { }
    this.stage.classList.remove('is-playing');
    this.root.classList.remove('is-playing');
  };

  Player.prototype.setChannel = function (ch) {
    this.ch = ch;
    this.bad = {};
    this.tries = 0;
    this.srcIdx = 0;
    this._renderHead();
    this.renderSources();
    this.renderPlaylist();
    this.playSource(0);
  };

  Player.prototype._renderHead = function () {
    var ch = this.ch, cc = ch.c;
    var info = (this.o.countries && this.o.countries[cc]) || null;
    logoInto(this.logoBox, ch);
    this.nameBox.textContent = ch.n;
    var bits = [ccLabel(cc, info)];
    if (ch.k && ch.k.length) bits.push(ch.k.slice(0, 2).join(' / '));
    bits.push(ch.s.length + ' 条线路');
    this.metaBox.textContent = bits.join('  ·  ');
    this.favBtn.classList.toggle('is-on', !!(this.o.isFav && this.o.isFav(ch)));
  };

  Player.prototype.isHlsUrl = function (u) { return /\.m3u8(\?|#|$)/i.test(u); };

  /* stop() 会清空 src 并 load()，此时浏览器会抛一个空源错误（code 4）。
     在 hls.js 按需下载期间这个错误会晚到，不能当成流中断，
     所以只有确实挂上了源（或 hls 已接管）时才认这个错误。 */
  Player.prototype.mediaReady = function () {
    return !!(this.hls || this.video.currentSrc);
  };

  Player.prototype.renderSources = function () {
    var self = this, box = this.sourcesBox;
    box.innerHTML = '';
    this.ch.s.forEach(function (s, i) {
      var b = el('button', 'src' + (i === self.srcIdx ? ' is-active' : '') + (self.bad[i] ? ' is-bad' : ''));
      var q = s[1] || '自动';
      b.appendChild(el('span', null, '线路 ' + (i + 1)));
      var qq = el('b', null, q);
      qq.style.fontWeight = '400';
      qq.style.opacity = '.72';
      b.appendChild(qq);
      b.title = s[0];
      b.addEventListener('click', function () { self.playSource(i); });
      box.appendChild(b);
    });
  };

  Player.prototype.setMsg = function (title, sub, actions, spin) {
    var self = this;
    this.msg.hidden = false;
    this.stage.classList.add('has-msg');
    this.msgTitle.textContent = title || '';
    this.msgSub.textContent = sub || '';
    this.spin.style.display = spin === false ? 'none' : 'block';
    this.msgActions.innerHTML = '';
    (actions || []).forEach(function (a) {
      var b = el('button', 'skeu-key', a.label);
      b.addEventListener('click', a.fn);
      self.msgActions.appendChild(b);
    });
  };

  Player.prototype.hideMsg = function () {
    this.msg.hidden = true;
    this.stage.classList.remove('has-msg');
  };

  Player.prototype.clearTimer = function () {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  };

  Player.prototype.playSource = function (i) {
    var self = this;
    var ch = this.ch;
    if (!ch || !ch.s.length) return;
    i = Math.max(0, Math.min(ch.s.length - 1, i));
    this.srcIdx = i;
    this.renderSources();

    var s = ch.s[i];
    var url = s[0];
    var ref = s[2];
    var gen = ++this.gen;

    this.stop();
    this.badge.textContent = (s[1] || 'LIVE') + ' · 线路 ' + (i + 1);

    var mixed = location.protocol === 'https:' && url.indexOf('http://') === 0;

    if (mixed) {
      this.bad[i] = 'mixed';
      this.setMsg('HTTPS 页面加载不了 HTTP 线路', '浏览器会拦截明文流，已自动跳下一条。', null, false);
      this.nextSource(1);
      return;
    }

    this.setMsg('正在连接信号…',
      ref ? '该线路需要 Referer（' + String(ref).replace(/^https?:\/\//, '').slice(0, 42) + '），浏览器无法伪造，可能失败。'
        : '若长时间无响应会自动切换下一条线路。', null, true);

    this.gen = gen;
    this.timer = setTimeout(function () {
      if (gen !== self.gen) return;
      self.fail('连接超时');
    }, 15000);

    var isHls = this.isHlsUrl(url);
    /* 注意：Chrome 的 canPlayType('...mpegurl') 会返回 "maybe"，但实际解不了 HLS
       （内核没有 MPEG-TS 解复用），照它走原生分支必然 err 4。
       所以只要浏览器有 MSE 就一律用 hls.js，原生只留给没有 MSE 的 Safari/iOS。 */
    var canMse = !!(window.MediaSource || window.ManagedMediaSource);
    var nativeHls = this.video.canPlayType('application/vnd.apple.mpegurl') !== '';

    function onErr() {
      if (gen !== self.gen || !self.mediaReady()) return;
      self.fail('视频流中断');
    }
    this.video.addEventListener('error', onErr);
    this._offErr = function () { self.video.removeEventListener('error', onErr); };

    if (isHls && canMse) {
      this.setMsg('正在准备播放组件…', '首次播放需要加载 HLS 解码库。', null, true);
      needHls(function (err) {
        if (gen !== self.gen) return;
        if (err || !window.Hls || !window.Hls.isSupported()) {
          self.fail('当前浏览器不支持 HLS 播放');
          return;
        }
        self.setMsg('正在连接信号…', ref ? '该线路需要 Referer，浏览器无法伪造，可能失败。' : '若长时间无响应会自动切换下一条线路。', null, true);
        // 下载 hls.js 这段不算线路超时，重新计时
        self.clearTimer();
        self.timer = setTimeout(function () {
          if (gen !== self.gen) return;
          self.fail('连接超时');
        }, 15000);
        var hls = new window.Hls(HLS_OPTS);
        self.hls = hls;
        hls.on(window.Hls.Events.ERROR, function (evt, data) {
          if (gen !== self.gen || !data || !data.fatal) return;
          self.fail(data.type === 'networkError' ? '网络 / 跨域被拒绝' : '解码失败');
        });
        hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
          if (gen !== self.gen) return;
          self.tryPlay();
        });
        hls.attachMedia(self.video);
        hls.loadSource(url);
      });
      return;
    } else if (isHls && nativeHls) {   // 无 MSE 的平台（iOS Safari）才走这里
      this.video.src = url;
      this.tryPlay();
    } else if (isHls) {
      this.fail('当前浏览器不支持 HLS');
      return;
    } else {
      this.video.src = url;
      this.tryPlay();
    }
  };

  Player.prototype.tryPlay = function (userGesture) {
    var self = this;
    this.cover.classList.add('is-on');
    var p = this.video.play();
    if (p && p.catch) {
      p.catch(function () {
        // 媒体本身有问题：直接算这条线路失败，别提示"点击播放"
        if (self.mediaReady() && self.video.error) { self.fail('线路无法解码'); return; }
        if (userGesture) {
          self.setMsg('浏览器阻止了播放', '点一下按钮开始。', [{ label: '开始播放', fn: function () { self.tryPlay(true); } }], false);
        } else {
          self.video.muted = true;
          self._syncMute();
          self.video.play().catch(function () {
            if (self.mediaReady() && self.video.error) { self.fail('线路无法解码'); return; }
            self.setMsg('点击播放', '浏览器要求先有一次用户交互。', [{ label: '开始播放', fn: function () { self.tryPlay(true); } }], false);
          });
        }
      });
    }
  };

  Player.prototype.nextSource = function (dir) {
    var n = this.ch.s.length;
    var next = this.srcIdx + (dir || 1);
    for (var k = 1; k <= n; k++) {
      var cand = ((next + k - 1) % n + n) % n;
      if (!this.bad[cand]) { this.playSource(cand); return; }
    }
    this.giveUp();
  };

  Player.prototype.fail = function (why) {
    this.clearTimer();
    this.bad[this.srcIdx] = why || true;
    this.o.onStatus && this.o.onStatus('failed', this.ch, why);
    if (this.hls) { try { this.hls.destroy(); } catch (e) { } this.hls = null; }
    this.expectUrl = '';
    try { this.video.pause(); } catch (e) { }
    var left = 0;
    for (var i = 0; i < this.ch.s.length; i++) if (!this.bad[i]) left++;
    this.renderSources();
    if (left > 0 && this.tries < 10) {
      this.tries++;
      this.nextSource(1);
    } else {
      this.giveUp(why);
    }
  };

  Player.prototype.giveUp = function (why) {
    var self = this;
    var url = this.ch.s[this.srcIdx] ? this.ch.s[this.srcIdx][0] : '';
    var n = this.ch.s.length, mixed = 0;
    for (var k = 0; k < n; k++) if (this.bad[k] === 'mixed') mixed++;
    this.o.onStatus && this.o.onStatus('dead', this.ch, why);
    if (mixed === n) {
      this.setMsg('这个频道只有明文线路',
        '它的 ' + n + ' 条线路全是 http://，HTTPS 页面下浏览器会直接拦截，网页里播不了。复制地址到 VLC / mpv 里可以正常看。',
        [
          { label: '复制播放地址', fn: function () { if (navigator.clipboard) navigator.clipboard.writeText(url); self.o.onStatus && self.o.onStatus('copied', self.ch); } },
          { label: 'VLC 打开', fn: function () { window.open(url, '_blank'); } },
          { label: '随机换一个', fn: function () { self.o.onRandom && self.o.onRandom(); } }
        ], false);
      return;
    }
    this.setMsg('这个频道暂时播不了',
      '已试过全部 ' + n + ' 条线路，都不通。常见原因：线路需要伪造 Referer / User-Agent、地区限制、或源已失效。换个频道，或把地址丢给 VLC 试试。',
      [
        { label: '重试全部线路', fn: function () { self.bad = {}; self.tries = 0; self.playSource(0); } },
        {
          label: '复制播放地址', fn: function () {
            if (navigator.clipboard) navigator.clipboard.writeText(url);
            self.o.onStatus && self.o.onStatus('copied', self.ch);
          }
        },
        { label: 'VLC 打开', fn: function () { window.open(url, '_blank'); } },
        { label: '随机换一个', fn: function () { self.o.onRandom && self.o.onRandom(); } }
      ], false);
  };

  Player.prototype.renderPlaylist = function () {
    var self = this;
    var q = (this.plFilter.value || '').trim().toLowerCase();
    var body = this.plBody;
    body.innerHTML = '';
    var list = this.playlist;
    if (q) {
      list = list.filter(function (c) {
        return c.n.toLowerCase().indexOf(q) >= 0 || (c.k || []).join(' ').toLowerCase().indexOf(q) >= 0;
      });
    }
    if (!list.length) { body.appendChild(el('div', 'suggest-empty', '没有匹配的频道')); return; }
    var limit = Math.min(list.length, 400);
    for (var i = 0; i < limit; i++) body.appendChild(this._row(list[i]));
    if (list.length > limit) {
      var more = el('div', 'suggest-empty', '还有 ' + fmt(list.length - limit) + ' 个频道，用上面的筛选框缩小范围');
      body.appendChild(more);
    }
  };

  Player.prototype._row = function (ch) {
    var self = this;
    var cur = this.ch && ch.i === this.ch.i;
    var row = el('div', 'row' + (cur ? ' is-active' : ''));
    row.appendChild(logoEl(ch, 'logoimg'));
    var main = el('div', 'row-main');
    main.appendChild(el('div', 'row-name', ch.n));
    var q = ch.s[0] && ch.s[0][1] ? ch.s[0][1] : '自动';
    main.appendChild(el('div', 'row-sub', (ch.k && ch.k.length ? ch.k[0] + ' · ' : '') + q + ' · ' + ch.s.length + ' 条线路'));
    row.appendChild(main);
    if (cur) {
      var bars = el('div', 'bars');
      bars.innerHTML = '<i></i><i></i><i></i>';
      row.appendChild(bars);
    }
    row.addEventListener('click', function () { self.setChannel(ch); });
    return row;
  };

  window.Player = Player;
})();

/* ===== app.js ===== */
/* ============================================================
   Globe TV — 应用主逻辑
   数据：iptv-org（https://github.com/iptv-org/iptv）
   ============================================================ */
// 由 boot.js 在频道数据就绪后调用（数据走 gz，所以不能在这里立即执行）
window.__startGlobeTV = function () {
  'use strict';

  var U = window.TVUtil;
  var el = U.el;
  var DATA = window.TV_DATA;
  if (!DATA) { console.error('TV_DATA 缺失'); return; }

  var CH = DATA.channels;
  var CC = DATA.countries;
  var CATS = DATA.categories;

  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------- 本地存储
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }

  // HTTPS 页面加载不了明文 http 流（浏览器按混合内容拦截）。
  // 线上链接是 HTTPS，所以默认只显示"至少有一条 https 线路"的频道，避免点到播不了的亮点。
  var IS_HTTPS = location.protocol === 'https:';
  var httpsOnly = lsGet('globetv.httpsOnly', null);
  if (httpsOnly === null) httpsOnly = IS_HTTPS;
  var visibleCats = [];

  // ---------------------------------------------------------- 索引
  var N = CH.length;
  var searchStr = new Array(N);
  var httpsFlag = new Uint8Array(N);   // 该频道是否至少有一条 https 线路
  var byCountry = {};
  var byCat = {};
  var idMap = {};
  var visMask = new Uint8Array(N);     // 当前筛选下是否可见
  var visCount = 0, visStreams = 0, visCountries = 0;
  var httpsIdx = [];                   // 有 https 线路的频道下标（原表）
  var safeIdx = [];                    // 当前筛选后"最可能能播"的频道下标

  (function buildIndex() {
    for (var i = 0; i < N; i++) {
      var ch = CH[i];
      idMap[ch.i] = ch;
      var info = CC[ch.c] || { n: ch.c, f: '' };
      searchStr[i] = (ch.n + ' ' + (ch.a || '') + ' ' + info.n + ' ' + ch.c + ' ' +
        (ch.k || []).join(' ')).toLowerCase();
      var hasHttps = false;
      for (var q = 0; q < ch.s.length; q++) if (ch.s[q][0].indexOf('https://') === 0) { hasHttps = true; break; }
      ch._h = hasHttps;
      httpsFlag[i] = hasHttps ? 1 : 0;
      if (hasHttps) httpsIdx.push(i);
    }
  })();

  // 按当前筛选重建可见索引（byCountry / byCat / 统计数字都跟着走）
  function refreshVisible() {
    byCountry = {};
    byCat = {};
    visCount = 0;
    visStreams = 0;
    visCountries = 0;
    var seenCountry = {};
    for (var i = 0; i < N; i++) {
      var on = !httpsOnly || httpsFlag[i];
      visMask[i] = on ? 1 : 0;
      if (!on) continue;
      var ch = CH[i];
      visCount++;
      visStreams += ch.s.length;
      if (!seenCountry[ch.c]) { seenCountry[ch.c] = 1; visCountries++; }
      (byCountry[ch.c] || (byCountry[ch.c] = [])).push(ch);
      var ks = ch.k && ch.k.length ? ch.k : ['general'];
      for (var j = 0; j < ks.length; j++) (byCat[ks[j]] || (byCat[ks[j]] = [])).push(ch);
    }
    // 每个国家内按"线路数多 → 名称"排序，最可能可播的排前面
    Object.keys(byCountry).forEach(function (cc) {
      byCountry[cc].sort(function (a, b) {
        return (b.s.length - a.s.length) || a.n.localeCompare(b.n, 'en');
      });
    });
    Object.keys(byCat).forEach(function (k) {
      byCat[k].sort(function (a, b) { return (b.s.length - a.s.length) || a.n.localeCompare(b.n, 'en'); });
    });
    visibleCats = CATS.filter(function (c) { return byCat[c.id] && byCat[c.id].length; });
    safeIdx = httpsOnly ? httpsIdx.slice() : httpsIdx;
  }

  function updateStats() {
    $('stat-ch').textContent = U.fmt(visCount);
    $('stat-cc').textContent = U.fmt(visCountries);
    $('stat-st').textContent = U.fmt(visStreams);
  }

  refreshVisible();
  updateStats();

  // ---------------------------------------------------------- 收藏 / 主题
  var favs = lsGet('globetv.fav', []);
  var favSet = {};
  favs.forEach(function (f) { favSet[f] = 1; });
  function isFav(ch) { return !!favSet[ch.i]; }
  function toggleFav(ch) {
    if (favSet[ch.i]) { delete favSet[ch.i]; favs = favs.filter(function (x) { return x !== ch.i; }); }
    else { favSet[ch.i] = 1; favs.unshift(ch.i); }
    lsSet('globetv.fav', favs);
    renderFav();
    return !!favSet[ch.i];
  }

  var theme = lsGet('globetv.theme', null);
  if (!theme) theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  document.documentElement.classList.toggle('dark', theme === 'dark');
  $('btn-theme').title = theme === 'dark' ? '切换到浅色' : '切换到深色';

  // ---------------------------------------------------------- toast
  function toast(msg, bad, ms) {
    var box = $('toasts');
    var t = el('div', 'toast' + (bad ? ' is-bad' : ''), msg);
    box.appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .3s ease,transform .3s ease';
      t.style.opacity = '0';
      t.style.transform = 'translateY(6px)';
      setTimeout(function () { t.remove(); }, 320);
    }, ms || 3200);
  }

  // ---------------------------------------------------------- 地球
  $('boot-sub').textContent = '正在绘制地球…';
  var globe = new window.GlobeView($('globe-canvas'));
  try {
    globe.init();
  } catch (e) {
    console.error(e);
    toast('WebGL 初始化失败，可能浏览器禁用了硬件加速', true, 8000);
  }
  globe.setCountries(CC);
  globe.setTheme(theme);
  globe.setData(DATA);
  globe.onTexError = function () { toast('地球贴图加载失败', true); };

  // 地球只渲染"当前筛选可见"的频道
  function applyFilter() {
    globe.setFilter(httpsOnly ? function (ch) { return !!ch._h; } : null);
  }
  applyFilter();

  // 当前悬停 / 播放
  var curCh = null;
  var curMeta = null;
  var curCountry = null;

  var tip = $('tip');
  var tipLogo = $('tip-logo');
  var tipName = $('tip-name');
  var tipMeta = $('tip-meta');
  var lastMouse = { x: 0, y: 0 };

  document.addEventListener('mousemove', function (e) { lastMouse.x = e.clientX; lastMouse.y = e.clientY; });

  function qualityTag(ch) {
    var best = '';
    for (var i = 0; i < ch.s.length; i++) {
      var q = ch.s[i][1];
      if (!q) continue;
      var m = /(\d{3,4})/.exec(q);
      var v = m ? parseInt(m[1], 10) : 0;
      if (v > (parseInt(best, 10) || 0)) best = String(v);
    }
    return best ? best + 'p' : '自动';
  }

  globe.hover = function (meta, idx, mx, my) {
    if (!meta) { tip.hidden = true; return; }
    var ch = meta.ch;
    var info = meta.info || {};
    U.logoInto(tipLogo, ch);
    tipName.textContent = ch.n;
    tipMeta.textContent = (info.f ? info.f + ' ' : '') + (info.n || ch.c) +
      ' · ' + qualityTag(ch) + ' · ' + ch.s.length + ' 条线路';
    tip.hidden = false;
    placeTip(mx == null ? lastMouse.x + 16 : mx + 16, my == null ? lastMouse.y + 14 : my + 14);
  };

  function placeTip(x, y) {
    var w = tip.offsetWidth || 260, h = tip.offsetHeight || 48;
    x = Math.min(x, window.innerWidth - w - 12);
    y = Math.min(y, window.innerHeight - h - 12);
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }

  // 提示框跟随亮点（亮点转到背面时自动隐藏）
  globe.hoverMove = function (p) {
    if (tip.hidden) return;
    placeTip(p.x + 18, p.y + 10);
  };

  // ---------------------------------------------------------- 播放
  var player = new window.Player({
    countries: CC,
    isFav: isFav,
    onToggleFav: function (ch) {
      var on = toggleFav(ch);
      toast(on ? '已收藏「' + ch.n + '」' : '已取消收藏');
      return on;
    },
    onRandom: function () { playRandom(); },
    onStatus: function (type, ch, why) {
      if (type === 'failed') toast('线路不通（' + why + '），自动换线…', false, 2200);
      else if (type === 'dead') toast('「' + ch.n + '」的线路都连不上，换一个试试', true, 4200);
      else if (type === 'timeout') toast('连接超时，换线中…', false, 2000);
      else if (type === 'copied') toast('播放地址已复制');
    }
  });

  function countryPlaylist(cc) {
    return (byCountry[cc] || []).slice();
  }

  function openChannel(ch, opts) {
    opts = opts || {};
    curCh = ch;
    curCountry = ch.c;
    tip.hidden = true;
    var info = CC[ch.c] || {};
    player.open(ch, countryPlaylist(ch.c), (info.f ? info.f + ' ' : '') + (info.n || ch.c) + ' 的全部频道');
    if (opts.focus !== false) globe.focusTo(ch.la, ch.lo, Math.min(globe.dist, 2.1), 900);
    curMeta = { ch: ch, cc: ch.c, info: info };
    globe.markSelected(curMeta);
    setActiveRow(ch);
  }

  globe.pick = function (meta) { openChannel(meta.ch, { focus: true }); };
  globe.bgPick = function () { };

  function playRandom() {
    var i = safeIdx[Math.floor(Math.random() * safeIdx.length)];
    if (i == null) return;
    openChannel(CH[i], { focus: true });
  }

  // ---------------------------------------------------------- 抽屉
  var drawer = $('drawer');
  var panes = { country: $('pane-country'), category: $('pane-category'), fav: $('pane-fav'), result: $('pane-result') };
  var curTab = 'country';
  var curCat = null;
  var activeRowEl = null;

  function setActiveRow(ch) {
    activeRowEl = null;
    if (drawer.classList.contains('is-open')) refreshPane();
  }

  function refreshPane() {
    if (curTab === 'country') renderCountries();
    else if (curTab === 'category') renderCats();
    else if (curTab === 'fav') renderFav();
    if (!panes.result.hidden) renderResults(searchInput.value.trim());
  }

  function showPane(name) {
    Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== name; });
  }

  function openDrawer(tab) {
    if (tab) selectTab(tab);
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
  }
  function selectTab(tab) {
    curTab = tab;
    Array.prototype.forEach.call($('drawer-tabs').children, function (b) {
      b.classList.toggle('is-active', b.dataset.tab === tab);
    });
    showPane(tab);
    if (tab === 'country') renderCountries();
    if (tab === 'category') renderCats();
    if (tab === 'fav') renderFav();
  }

  function channelRow(ch, subExtra) {
    var info = CC[ch.c] || {};
    var row = el('div', 'row' + (curCh && curCh.i === ch.i ? ' is-active' : ''));
    if (subExtra === 'flag') row.appendChild(el('div', 'row-flag', info.f || ''));
    else row.appendChild(U.logoEl(ch, 'logoimg'));
    var main = el('div', 'row-main');
    main.appendChild(el('div', 'row-name', ch.n));
    var sub = [];
    if (subExtra === 'flag') sub.push(info.n || ch.c);
    sub.push(qualityTag(ch));
    if (ch.k && ch.k.length) sub.push(ch.k[0]);
    sub.push(ch.s.length + ' 线路');
    main.appendChild(el('div', 'row-sub', sub.join(' · ')));
    row.appendChild(main);
    if (curCh && curCh.i === ch.i) {
      var bars = el('div', 'bars');
      bars.innerHTML = '<i></i><i></i><i></i>';
      row.appendChild(bars);
    } else if (isFav(ch)) {
      var st = el('div', 'row-count', '★');
      st.style.color = 'var(--favorite)';
      row.appendChild(st);
    }
    row.addEventListener('click', function () { openChannel(ch, { focus: true }); });
    return row;
  }

  function renderCountries() {
    var box = panes.country;
    box.innerHTML = '';
    box.appendChild(el('div', 'list-title', '共 ' + U.fmt(visCountries) + ' 个国家 / 地区'));
    var list = Object.keys(byCountry).sort(function (a, b) {
      return byCountry[b].length - byCountry[a].length;
    });
    list.forEach(function (cc) {
      var info = CC[cc] || {};
      var row = el('div', 'row');
      row.appendChild(el('div', 'row-flag', info.f || ''));
      var main = el('div', 'row-main');
      main.appendChild(el('div', 'row-name', info.n || cc));
      main.appendChild(el('div', 'row-sub', byCountry[cc].length + ' 个频道 · 点击飞过去'));
      row.appendChild(main);
      row.appendChild(el('div', 'row-count', String(byCountry[cc].length)));
      row.addEventListener('click', function () {
        globe.focusTo(info.la, info.lo, 1.95, 1100);
        var ch = byCountry[cc][0];
        if (ch) openChannel(ch, { focus: false });
        toast((info.f || '') + ' ' + (info.n || cc) + ' · ' + byCountry[cc].length + ' 个频道');
        if (window.innerWidth < 900) closeDrawer();
      });
      box.appendChild(row);
    });
  }

  function renderCats() {
    var box = panes.category;
    box.innerHTML = '';
    box.appendChild(el('div', 'list-title', '按类型找频道'));
    var wrap = el('div', 'chipwrap');
    var all = el('button', 'chip' + (curCat == null ? ' is-active' : ''), '全部类型');
    all.addEventListener('click', function () { curCat = null; renderCats(); renderCatList(); });
    wrap.appendChild(all);
    visibleCats.forEach(function (c) {
      var b = el('button', 'chip' + (curCat === c.id ? ' is-active' : ''), c.n + ' ' + (byCat[c.id] ? byCat[c.id].length : 0));
      b.addEventListener('click', function () { curCat = c.id; renderCats(); renderCatList(); });
      wrap.appendChild(b);
    });
    box.appendChild(wrap);
    var curName = curCat ? (CATS.filter(function (c) { return c.id === curCat; })[0] || {n:curCat}).n : '热门频道';
    box.appendChild(el('div', 'list-title', curCat ? curName + ' · ' + byCat[curCat].length + ' 个频道' : curName));
    var listBox = el('div');
    listBox.id = 'catlist';
    box.appendChild(listBox);
    renderCatList();
  }

  function renderCatList() {
    var listBox = document.getElementById('catlist');
    if (!listBox) return;
    listBox.innerHTML = '';
    var list;
    if (curCat) list = byCat[curCat] || [];
    else {
      list = safeIdx.map(function (i) { return CH[i]; });
      list.sort(function (a, b) { return b.s.length - a.s.length; });
    }
    var limit = 300;
    for (var i = 0; i < Math.min(list.length, limit); i++) listBox.appendChild(channelRow(list[i], true));
    if (list.length > limit) listBox.appendChild(el('div', 'suggest-empty', '仅显示前 ' + limit + ' 个，共 ' + U.fmt(list.length) + ' 个'));
  }

  function renderFav() {
    var box = panes.fav;
    box.innerHTML = '';
    if (!favs.length) {
      box.appendChild(el('div', 'list-title', '收藏夹'));
      box.appendChild(el('div', 'suggest-empty', '还没有收藏。播放时点右上角的星标即可收藏。'));
      return;
    }
    box.appendChild(el('div', 'list-title', '收藏 ' + favs.length + ' 个频道'));
    favs.forEach(function (id) {
      var ch = idMap[id];
      if (ch) box.appendChild(channelRow(ch, true));
    });
  }

  // ---------------------------------------------------------- 搜索结果
  function search(q) {
    q = q.trim().toLowerCase();
    var out = [];
    if (!q) return out;
    for (var i = 0; i < N; i++) {
      if (visMask[i] && searchStr[i].indexOf(q) >= 0) {
        out.push(CH[i]);
        if (out.length >= 600) break;
      }
    }
    out.sort(function (a, b) {
      var ai = a.n.toLowerCase().indexOf(q), bi = b.n.toLowerCase().indexOf(q);
      if (ai !== bi) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      return b.s.length - a.s.length;
    });
    return out;
  }

  var suggest = $('suggest');
  var searchInput = $('search-input');
  var searchTimer = null;

  function renderSuggest(q) {
    if (!q) { suggest.hidden = true; return; }
    var res = search(q).slice(0, 8);
    suggest.innerHTML = '';
    if (!res.length) {
      suggest.appendChild(el('div', 'suggest-empty', '没找到相关频道'));
    } else {
      res.forEach(function (ch) { suggest.appendChild(channelRow(ch, true)); });
      var all = el('div', 'row');
      all.style.justifyContent = 'center';
      all.appendChild(el('div', 'row-sub', '在左侧面板查看全部结果 →'));
      all.addEventListener('click', function () { suggest.hidden = true; openDrawer('result'); });
      suggest.appendChild(all);
    }
    suggest.hidden = false;
  }

  function renderResults(q) {
    var box = panes.result;
    box.innerHTML = '';
    var res = search(q);
    box.appendChild(el('div', 'list-title', '“' + q + '” 匹配 ' + U.fmt(res.length) + ' 个频道'));
    if (!res.length) { box.appendChild(el('div', 'suggest-empty', '换个关键词试试')); return; }
    var limit = Math.min(res.length, 400);
    for (var i = 0; i < limit; i++) box.appendChild(channelRow(res[i], true));
    if (res.length > limit) box.appendChild(el('div', 'suggest-empty', '仅显示前 ' + limit + ' 个'));
  }

  searchInput.addEventListener('input', function () {
    var q = searchInput.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { renderSuggest(q); }, 110);
    if (q.length >= 2) {
      showPane('result');
      drawer.classList.add('is-open');
      renderResults(q);
    } else if (!q) {
      if (curTab !== 'result') showPane(curTab);
      suggest.hidden = true;
    }
  });
  searchInput.addEventListener('focus', function () {
    if (searchInput.value.trim()) renderSuggest(searchInput.value.trim());
  });
  document.addEventListener('click', function (e) {
    if (!$('suggest').contains(e.target) && e.target !== searchInput) suggest.hidden = true;
    if (drawer.classList.contains('is-open') && !drawer.contains(e.target) &&
      !e.target.closest('.topbar') && !e.target.closest('#player')) {
      if (window.innerWidth < 900) closeDrawer();
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
    if (e.key === 'Escape') { suggest.hidden = true; if (document.activeElement === searchInput) searchInput.blur(); }
  });

  // ---------------------------------------------------------- 顶栏动作
  $('btn-random').addEventListener('click', function () {
    playRandom();
  });
  $('btn-browse').addEventListener('click', function () {
    if (drawer.classList.contains('is-open') && curTab !== 'result') closeDrawer();
    else openDrawer('country');
  });
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-tabs').addEventListener('click', function (e) {
    var b = e.target.closest('.tab');
    if (b) selectTab(b.dataset.tab);
  });
  $('btn-theme').addEventListener('click', function () {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', theme === 'dark');
    $('btn-theme').title = theme === 'dark' ? '切换到浅色' : '切换到深色';
    lsSet('globetv.theme', theme);
    globe.setTheme(theme);
  });

  // 仅 HTTPS 可播：HTTPS 页面下默认开启（明文 http 流会被浏览器拦掉）
  var httpsBtn = $('btn-https');
  function syncHttpsBtn() {
    httpsBtn.hidden = !IS_HTTPS;
    httpsBtn.classList.toggle('is-on', httpsOnly);
    httpsBtn.title = httpsOnly
      ? '当前只显示至少有一条 HTTPS 线路的频道（点击显示全部）'
      : '显示全部频道（点击仅保留 HTTPS 可播的）';
  }
  httpsBtn.addEventListener('click', function () {
    httpsOnly = !httpsOnly;
    lsSet('globetv.httpsOnly', httpsOnly);
    refreshVisible();
    updateStats();
    applyFilter();
    syncHttpsBtn();
    refreshPane();
    toast(httpsOnly
      ? '只显示 HTTPS 可播的频道 · ' + U.fmt(visCount) + ' 个'
      : '已显示全部频道 · ' + U.fmt(visCount) + ' 个（明文 http 线路在 HTTPS 页面下无法播放）');
  });
  syncHttpsBtn();
  $('z-in').addEventListener('click', function () { globe.zoomBy(0.82); });
  $('z-out').addEventListener('click', function () { globe.zoomBy(1.22); });
  $('z-reset').addEventListener('click', function () { globe.focusTo(20, 25, 3.1, 900); });
  $('brand').addEventListener('click', function () { globe.focusTo(20, 25, 3.1, 900); });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'r' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) playRandom();
  });

  // ---------------------------------------------------------- 更新提醒
  /* 版本号写在 assets/js/changelog.js，发版时改那里（改完记得重跑 bundle.py）。
     这里把它和本地记录的已读版本比对：
       - 第一次来（本地没有记录）→ 静默记下，不打扰
       - 检测到新版本 → 右上角按钮点小圆点，并自动弹出一次更新说明
     目的是让用户知道「这次更新改了什么」，而不是默默变了。 */
  (function initUpdates() {
    var CL = window.TV_CHANGELOG;
    var btn = $('btn-updates');
    if (!CL || !CL.entries || !CL.entries.length || !btn) { if (btn) btn.hidden = true; return; }

    var box = $('upd'), body = $('upd-body'), dot = $('upd-dot');
    var KEY = 'globetv.seenVersion';
    var seen = lsGet(KEY, null);
    var isNew = seen !== CL.current;
    $('upd-cur').textContent = CL.current;

    // 用 el() 建节点（走 textContent），不拼 innerHTML
    CL.entries.forEach(function (e) {
      var item = el('div', 'upd-item' + (isNew && e.v === CL.current ? ' is-new' : ''));
      var top = el('div', 'upd-item-top');
      top.appendChild(el('span', 'upd-v', e.v));
      top.appendChild(el('span', 'upd-item-name', e.title || ''));
      top.appendChild(el('span', 'upd-date', e.date || ''));
      item.appendChild(top);
      var ul = el('ul', 'upd-list');
      (e.items || []).forEach(function (t) { ul.appendChild(el('li', null, t)); });
      item.appendChild(ul);
      body.appendChild(item);
    });

    function open() { box.hidden = false; lsSet(KEY, CL.current); dot.hidden = true; }
    function close() { box.hidden = true; }
    btn.addEventListener('click', function () { if (box.hidden) open(); else close(); });
    $('upd-close').addEventListener('click', close);
    box.addEventListener('click', function (e) { if (e.target === box) close(); });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !box.hidden) { e.stopPropagation(); close(); }
    });

    if (seen === null) {
      lsSet(KEY, CL.current);            // 第一次访问：记录下来但不弹窗
    } else if (isNew) {
      dot.hidden = false;                // 先点小圆点，等启动页收完再弹说明
      setTimeout(function () {
        open();
        toast('已更新到 ' + CL.current + ' · 这里是改动内容', false, 4600);
      }, 1200);
    }
  })();

  // ---------------------------------------------------------- 启动画面
  selectTab('country');
  renderFav();

  /* 等地球贴图真正挂上再收起启动页。
     贴图没到就收，用户会看到一个没有纹理的球（在深色主题下就是一个黑球）。 */
  var revealed = false;
  function reveal() {
    if (revealed) return;
    revealed = true;
    $('boot').classList.add('is-done');
    setTimeout(function () {
      var b = $('boot');
      if (b && b.parentNode) b.parentNode.removeChild(b);
    }, 700);
    toast('准备好了 · 点地球上任意一个亮点开始播放', false, 4200);
    if (IS_HTTPS && httpsOnly) {
      setTimeout(function () {
        toast('HTTPS 页面下已过滤掉只有明文线路的频道，可点右上角「仅 HTTPS」显示全部', false, 6500);
      }, 4600);
    }
  }
  if (globe.texReady) setTimeout(reveal, 300);
  else globe.onTexReady = function () { setTimeout(reveal, 260); };
  // 兜底：贴图慢或彻底失败时也不能一直卡在启动页
  setTimeout(reveal, 9000);

  // 首屏随机一个频道？不自动播放，避免打扰
  window.GlobeTV = {
    data: DATA,
    play: function (id) { if (idMap[id]) openChannel(idMap[id]); },
    random: playRandom,
    globe: globe,
    player: player
  };
};

/* ===== boot.js ===== */
/* ============================================================
   Globe TV — 数据加载 + 启动
   静态托管一般不做 gzip，所以数据额外预压了一份 gz（3.1MB -> 0.68MB）。
   这里优先带进度地拉 gz，再用浏览器原生 DecompressionStream 解压；
   拿不到（老浏览器 / file:// 直开）就退回普通 <script>。
   ============================================================ */
(function () {
  'use strict';

  var GZ = 'assets/js/data/channels.json.gz';
  var PLAIN = 'assets/js/data/channels.js';
  var sub = document.getElementById('boot-sub');
  var started = false;
  var guard = null;
  var pendingReader = null;

  function say(t) { if (sub) sub.textContent = t; }

  function finish(via) {
    if (started) return;
    started = true;
    if (guard) { clearTimeout(guard); guard = null; }
    if (typeof window.__startGlobeTV !== 'function') {
      console.error('启动入口缺失（app.js 未加载）');
      return;
    }
    window.__startGlobeTV();
  }

  function plain() {
    if (started) return;
    say('载入频道目录…');
    var s = document.createElement('script');
    s.src = PLAIN;
    s.onload = function () { finish('plain'); };
    s.onerror = function () {
      say('频道数据加载失败，请刷新重试');
      console.error('无法加载 ' + PLAIN);
    };
    document.head.appendChild(s);
  }

  function pump(reader, chunks, got, total) {
    return reader.read().then(function (res) {
      if (res.done) {
        var all = new Uint8Array(got), off = 0;
        for (var i = 0; i < chunks.length; i++) { all.set(chunks[i], off); off += chunks[i].length; }
        return all.buffer;
      }
      chunks.push(res.value);
      got += res.value.length;
      say(total ? '下载频道目录 ' + Math.round(got / total * 100) + '%'
        : '下载频道目录 ' + (got / 1024 | 0) + ' KB');
      return pump(reader, chunks, got, total);
    });
  }

  function loadGz() {
    if (started) return;
    // file:// 下 fetch 会被同源策略拦掉，直接用未压缩版本
    if (location.protocol === 'file:') return plain();
    if (!('DecompressionStream' in window) || !window.fetch) return plain();
    say('连接服务器…');

    // index.html 里的内联脚本已经提前发了这个请求，这里直接复用它
    Promise.resolve(window.__tvGz || fetch(GZ))
      .then(function (r) {
        if (!r) throw new Error('无网络响应');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var total = parseInt(r.headers.get('Content-Length') || '0', 10);
        if (!r.body) return r.arrayBuffer();
        pendingReader = r.body.getReader();
        return pump(pendingReader, [], 0, total);
      })
      .then(function (buf) {
        say('解压数据 ' + ((buf.byteLength / 1048576) || 0).toFixed(1) + ' MB…');
        var stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Response(stream).text();
      })
      .then(function (txt) {
        say('解析频道数据…');
        window.TV_DATA = JSON.parse(txt);
        finish('gz');
      })
      .catch(function (e) {
        console.warn('gz 数据加载失败，改用未压缩版本：', e && e.message);
        if (pendingReader) { try { pendingReader.cancel(); } catch (x) { } }
        plain();
      });
  }

  guard = setTimeout(function () {
    if (!started) { console.warn('gz 数据加载超时，改用未压缩版本'); plain(); }
  }, 15000);

  // 内联脚本已经发了请求，这里立刻开始读进度；数据请求与库文件下载是并行的
  loadGz();
})();
