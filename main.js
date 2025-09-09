import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { add } from 'three/tsl';

/* ------------------ Config ------------------ */
const CONFIG = {
  AU: 60,                   // 1 AU -> scene units (distances)
  radiusScale: 2.0,         // visual scale for planet sizes
  timeScale: 1.0,           // global sim speed
  orbitalSpeedBoost: 1_000_000, // BIG boost so motion is visible but ratios stay real
  showGrid: false,          // toggle ground grid
  bloomStrength: 0.8,
  bloomRadius: 1.0,
  bloomThreshold: 0.22,
  labelScale: 1.6
};

/* -------------- Renderer / Scene / Camera -------------- */
const container = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.physicallyCorrectLights = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  45,
  container.clientWidth / container.clientHeight,
  0.1,
  10000
);
camera.position.set(0, 80, 220);



/* ------------------ Controls ------------------ */
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

/* ------------------ Starfield ------------------ */
const starGeo = new THREE.SphereGeometry(5000, 64, 64);
const starMat = new THREE.MeshBasicMaterial({ color: 0x0b0b16, side: THREE.BackSide });
scene.add(new THREE.Mesh(starGeo, starMat));

/* ------------------ Lights ------------------ */
scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 0.3));
const sunLight = new THREE.PointLight(0xffffff, 2.2, 0, 2);
scene.add(sunLight);

// ---- Animated "lava" shader for the Sun ----
const sunUniforms = {
  uTime:     { value: 0 },
  uScale:    { value: 3.0 },     // noise scale (bigger = more, smaller blobs)
  uSpeed:    { value: 0.12 },    // flow speed
  uCrack:    { value: 0.55 },    // threshold for dark crust vs hot lava
  uGlow:     { value: 2.2 },     // overall emissive boost (works great with bloom)
  uColorHot: { value: new THREE.Color(0xff6a00) }, // lava
  uColorMid: { value: new THREE.Color(0xffe080) }, // mid
  uColorDark:{ value: new THREE.Color(0x2a0700) }  // crust
};

// Simple 3D noise + fBm (compact)
const SUN_VERTEX = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
  }
`;

const SUN_FRAGMENT = /* glsl */`
  precision mediump float;
  varying vec2 vUv;
  uniform float uTime, uScale, uSpeed, uCrack, uGlow;
  uniform vec3 uColorHot, uColorMid, uColorDark;

  // hash & noise helpers
  float hash(vec3 p){ p = fract(p*0.3183099+vec3(0.1,0.2,0.3)); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
  float noise(vec3 p){
    vec3 i=floor(p),f=fract(p);
    f=f*f*(3.0-2.0*f);
    float n= mix(
      mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),
          mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
      mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),
          mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y), f.z);
    return n;
  }
  float fbm(vec3 p){
    float a=0.5, s=0.0;
    for(int i=0;i<5;i++){
      s += a*noise(p);
      p = p*2.02 + 11.5;
      a *= 0.5;
    }
    return s;
  }

  void main() {
    // flow field: warp uv, scroll over time
    vec2 uv = vUv * uScale;
    float t = uTime * uSpeed;

    // 3D domain to avoid seams, using uv as xy and time as z
    float n = fbm(vec3(uv, t));
    float n2 = fbm(vec3(uv + vec2(0.3, -0.2) + n*0.4, t*0.7));
    float lava = smoothstep(uCrack, 1.0, max(n, n2)); // hot only where noise is high

    // color ramp
    vec3 col = mix(uColorDark, uColorMid, n);
    col = mix(col, uColorHot, lava);

    // emissive glow (let post-bloom do the bloom)
    col *= uGlow * (0.8 + 0.2 * sin(t*6.2831)); // subtle pulsation

    gl_FragColor = vec4(col, 1.0);
  }
`;

function createSunMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: sunUniforms,
    vertexShader: SUN_VERTEX,
    fragmentShader: SUN_FRAGMENT
  });
}

/* ------------------ Sun ------------------ */
const sun = new THREE.Mesh(
  new THREE.SphereGeometry(16 * CONFIG.radiusScale, 64, 64),
  createSunMaterial()
);
scene.add(sun);
sunLight.position.copy(sun.position);
addToBloom(sun);

/* ------------------ Helpers ------------------ */
const grid = new THREE.GridHelper(600, 60, 0x333333, 0x111111);
grid.material.transparent = true;
grid.material.opacity = 0.15;
grid.visible = CONFIG.showGrid;
scene.add(grid);

/* --------------- Post-processing (Selective Bloom) --------------- */
const BLOOM_LAYER = 1;

const addToBloom = (mesh) => mesh.layers.enable(BLOOM_LAYER);

const darkMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
const materials = new Map();
function darkenNonBloom(obj) {
  if (obj.isMesh && !obj.layers.test(BLOOM_LAYER)) {
    materials.set(obj, obj.material);
    obj.material = darkMaterial;
  }
}
function restoreMaterials(obj) {
  if (materials.has(obj)) {
    obj.material = materials.get(obj);
    materials.delete(obj);
  }
}

/* ------------------ Materials ------------------ */
const planetMat = (color) =>
  new THREE.MeshStandardMaterial({
    color,
    emissive: new THREE.Color(color).multiplyScalar(0.05),
    metalness: 0.0,
    roughness: 1.0
  });

/* -------------- Orbits (AU + Sidereal Periods) -------------- */
const AU = CONFIG.AU;
const PLANETS = [
  { name: 'Mercury', radius: 1.3 * CONFIG.radiusScale,  a_AU: 0.387,   period_days: 87.969,   color: 0xaaaaaa },
  { name: 'Venus',   radius: 2.1 * CONFIG.radiusScale,  a_AU: 0.723,   period_days: 224.701,  color: 0xffd27f },
  { name: 'Earth',   radius: 2.2 * CONFIG.radiusScale,  a_AU: 1.000,   period_days: 365.256,  color: 0x3ba3ff },
  { name: 'Mars',    radius: 1.8 * CONFIG.radiusScale,  a_AU: 1.524,   period_days: 686.980,  color: 0xff6a4b },
  { name: 'Jupiter', radius: 8.5 * CONFIG.radiusScale,  a_AU: 5.203,   period_days: 4332.59,  color: 0xffaa00 },
  { name: 'Saturn',  radius: 7.3 * CONFIG.radiusScale,  a_AU: 9.537,   period_days: 10759.2,  color: 0xffe680 },
  { name: 'Uranus',  radius: 3.7 * CONFIG.radiusScale,  a_AU: 19.191,  period_days: 30685.4,  color: 0x80ffff },
  { name: 'Neptune', radius: 3.5 * CONFIG.radiusScale,  a_AU: 30.07,   period_days: 60190,    color: 0x5f7dff }
];

const axialTilts = { Mercury:0.01, Venus:177.4, Earth:23.4, Mars:25.2, Jupiter:3.1, Saturn:26.7, Uranus:97.8, Neptune:28.3 };

// Use seconds for mean motion to avoid tiny per-ms steps
const now = Date.now();
const daySec = 86400;
const phaseOffsets = { Mercury:0.1, Venus:1.2, Earth:2.1, Mars:3.0, Jupiter:0.5, Saturn:1.6, Uranus:2.7, Neptune:3.8 };

/* ------------------ Labels ------------------ */
function makeLabel(text, scale = CONFIG.labelScale) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = '20px system-ui';
  const w = ctx.measureText(text).width + 24;
  const h = 40;
  canvas.width = w; canvas.height = h;
  ctx.font = '20px system-ui';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0,0,w,h);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, 12, 26);

  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  const factor = 0.04; // global label size factor
  sprite.scale.set(w * factor * scale, h * factor * scale, 1);
  return sprite;
}

/* ------------------ Planets ------------------ */
function makePlanet(p) {
  const group = new THREE.Group();
  scene.add(group);

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(p.radius, 48, 48),
    planetMat(p.color)
  );

  // distance in scene units
  const distance = p.a_AU * AU;

  // axial tilt
  mesh.rotation.z = THREE.MathUtils.degToRad(axialTilts[p.name] || 0);

  // mean motion (rad/sec) & initial angle
  const periodSec = p.period_days * daySec;
  const meanMotionSec = (2 * Math.PI) / periodSec; // rad per second

  const nowSec = (now / 1000) % periodSec;
  const theta0 = meanMotionSec * nowSec + (phaseOffsets[p.name] || 0);

  // initial position
  mesh.position.set(
    Math.cos(theta0) * distance,
    0,
    Math.sin(theta0) * distance
  );

  group.add(mesh);

  // label
  const label = makeLabel(p.name);
  label.position.set(0, p.radius + 2, 0);
  mesh.add(label);

  addToBloom(mesh);

  return {
    name: p.name,
    group,
    mesh,
    radius: p.radius,
    distance,
    meanMotionSec,     // rad/s
    theta: theta0,     // current orbital angle
    spin: 0.01 + Math.random() * 0.02
  };
}

const planets = PLANETS.map(makePlanet);

// Sun should bloom
addToBloom(sun);

/* ------------------ Saturn’s Rings ------------------ */
const saturn = planets.find(p => p.name === 'Saturn');
if (saturn) {
  const inner = saturn.radius * 1.3;
  const outer = saturn.radius * 2.2;
  const ringGeo = new THREE.RingGeometry(inner, outer, 128);

  const pos = ringGeo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const r = Math.hypot(x, y);
    uv[i * 2] = (r - inner) / (outer - inner);
    uv[i * 2 + 1] = 1.0;
  }
  ringGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

  const ringMat = new THREE.MeshBasicMaterial({ color: 0xf5deb3, side: THREE.DoubleSide, transparent: true, opacity: 0.7 });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = Math.PI / 2;
  ring.rotation.z = saturn.mesh.rotation.z; // align with tilt
  saturn.mesh.add(ring);
  addToBloom(ring);
}

/* ------------------ Earth’s Moon ------------------ */
const earth = planets.find(p => p.name === 'Earth');
const moonGroup = new THREE.Group();
earth.mesh.add(moonGroup);

const moon = new THREE.Mesh(
  new THREE.SphereGeometry(0.7 * CONFIG.radiusScale, 24, 24),
  planetMat(0xcccccc)
);
moon.position.x = 5.5;
moonGroup.add(moon);
addToBloom(moon);

// Moon angular speed (~27.3 days)
const moonPeriodSec = 27.3 * daySec;
const moonMeanMotionSec = (2 * Math.PI) / moonPeriodSec;
let moonAngle = Math.random() * Math.PI * 2;

/* ------------------ Orbit Rings (visual) ------------------ */
function makeOrbitRing(distance) {
  const curve = new THREE.EllipseCurve(0, 0, distance, distance);
  const pts = curve.getPoints(256).map(p => new THREE.Vector3(p.x, 0.01, p.y));
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: 0x333344 });
  scene.add(new THREE.LineLoop(geo, mat));
}
PLANETS.forEach(p => makeOrbitRing(p.a_AU * AU));

/* ------------------ Resize ------------------ */
function onResize() {
  const w = container.clientWidth, h = container.clientHeight;
  renderer.setSize(w, h);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);

/* ------------------ Perf niceties ------------------ */
const clock = new THREE.Clock();
// clamp dt to avoid jumps after tab switch; keeps motion smooth
function getClampedDelta() { return Math.min(clock.getDelta(), 0.05); }

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clock.stop(); else clock.start();
});

/* ------------------ Animation ------------------ */
function animate() {
  const dt = getClampedDelta(); // seconds

  // Sun subtle spin
  sun.rotation.y += 0.002 * CONFIG.timeScale;

  // Orbits + spins (explicit circular motion)
  const warp = CONFIG.timeScale * CONFIG.orbitalSpeedBoost;
  planets.forEach(p => {
    p.theta += p.meanMotionSec * dt * warp; // rad
    p.mesh.position.set(
      Math.cos(p.theta) * p.distance,
      0,
      Math.sin(p.theta) * p.distance
    );
    p.mesh.rotation.y += p.spin * CONFIG.timeScale * 1.4;
  });

  // Moon orbit
  moonAngle += moonMeanMotionSec * dt * warp;
  moonGroup.rotation.y = moonAngle;

  controls.update();

  // Selective bloom
  scene.traverse(darkenNonBloom);
  composer.render();
  scene.traverse(restoreMaterials);

  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);
