import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** Renderer, lights, floor, camera and a few beat-reactive props. */
export class Scene {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.bg = new THREE.Color(0x0e1018);
    this.scene.background = this.bg.clone();
    this.scene.fog = new THREE.Fog(this.bg, 8, 22);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.6;

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
    this.camera.position.set(0, 1.4, 4.2);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.95, 0);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.52;
    this.controls.minDistance = 1; this.controls.maxDistance = 12;

    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x30241c, 0.6);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2.5, 5, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5; key.shadow.camera.far = 15;
    key.shadow.camera.left = key.shadow.camera.bottom = -3;
    key.shadow.camera.right = key.shadow.camera.top = 3;
    key.shadow.bias = -0.0005;
    this.scene.add(key);
    this.rim = new THREE.PointLight(0x6a8cff, 6, 12, 1.6);
    this.rim.position.set(-2.5, 2.2, -2.5);
    this.scene.add(this.rim);
    this.kick = new THREE.PointLight(0xff6a3d, 0, 10, 1.8);
    this.kick.position.set(0, 0.3, 1.5);
    this.scene.add(this.kick);

    // floor
    const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 64), new THREE.MeshStandardMaterial({ color: 0x151826, roughness: 0.9, metalness: 0.0 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    this.scene.add(floor);
    const grid = new THREE.GridHelper(12, 24, 0x2a3050, 0x1c2136);
    grid.position.y = 0.001; grid.material.transparent = true; grid.material.opacity = 0.6;
    this.scene.add(grid);

    // beat ring
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.0, 64), new THREE.MeshBasicMaterial({ color: 0x5aa0ff, transparent: true, opacity: 0, side: THREE.DoubleSide }));
    this.ring.rotation.x = -Math.PI / 2; this.ring.position.y = 0.004;
    this.scene.add(this.ring);
    this.ringT = 1;

    // spectrum bars behind the dancer
    this.barCount = 48;
    this.bars = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 1, 0.08), new THREE.MeshStandardMaterial({ color: 0x7fb3ff, emissive: 0x2f5fff, emissiveIntensity: 0.6, roughness: 0.4 }), this.barCount);
    this.bars.castShadow = false;
    this.scene.add(this.bars);
    this._barM = new THREE.Matrix4(); this._barS = new THREE.Vector3(); this._barP = new THREE.Vector3(); this._barQ = new THREE.Quaternion();

    this.model = null;
    this.skeletonHelper = null;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const c = this.renderer.domElement;
    const w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  /** Put the model on the floor, normalise its height to ~1.75m, frame the camera. */
  setModel(object, { targetHeight = 1.75 } = {}) {
    if (this.holder) { this.scene.remove(this.holder); disposeTree(this.holder); }
    if (this.skeletonHelper) { this.scene.remove(this.skeletonHelper); this.skeletonHelper = null; }
    // The model keeps its native transform (so exports stay in the author's units); a holder group
    // carries the view normalisation.
    const holder = new THREE.Group(); holder.name = 'ModelHolder';
    holder.add(object);
    this.model = object; this.holder = holder;
    holder.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const h = size.y || 1;
    const s = targetHeight / h;
    if (Math.abs(1 - s) > 0.02) holder.scale.setScalar(s);
    holder.updateWorldMatrix(true, true);
    box.setFromObject(object);
    const center = box.getCenter(new THREE.Vector3());
    holder.position.x -= center.x; holder.position.z -= center.z; holder.position.y -= box.min.y;
    object.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; if (o.frustumCulled) o.frustumCulled = false; } });
    this.scene.add(holder);
    this.controls.target.set(0, targetHeight * 0.55, 0);
    this.camera.position.set(0.6, targetHeight * 0.8, targetHeight * 2.4);
    return object;
  }

  showSkeleton(on) {
    if (this.skeletonHelper) { this.scene.remove(this.skeletonHelper); this.skeletonHelper = null; }
    if (on && this.model) {
      this.skeletonHelper = new THREE.SkeletonHelper(this.model);
      this.skeletonHelper.material.depthTest = false;
      this.skeletonHelper.material.transparent = true;
      this.skeletonHelper.material.opacity = 0.9;
      this.scene.add(this.skeletonHelper);
    }
  }

  /** @param {import('../audio/AudioAnalyzer.js').AudioFeatures} f */
  render(f, dt) {
    this.controls.update();
    // beat ring
    if (f.beat && f.locked) this.ringT = 0;
    this.ringT = Math.min(1, this.ringT + dt * 1.8);
    const r = 1 + this.ringT * 1.6;
    this.ring.scale.set(r, r, 1);
    this.ring.material.opacity = (1 - this.ringT) * 0.7;
    // kick light
    this.kick.intensity = Math.max(0, this.kick.intensity - dt * 40);
    if (f.onsets.low) this.kick.intensity = 10 * f.strength.low;
    this.rim.intensity = 4 + 8 * f.bands.high;
    // background pulse
    this.scene.background.copy(this.bg).offsetHSL(0, 0, f.bands.low * 0.03);
    // spectrum bars
    if (f.spectrum && f.spectrum.length) {
      const n = this.barCount, spec = f.spectrum, bins = spec.length;
      for (let i = 0; i < n; i++) {
        // log-spaced bins
        const lo = Math.floor(Math.pow(bins * 0.5, i / n)), hi = Math.max(lo + 1, Math.floor(Math.pow(bins * 0.5, (i + 1) / n)));
        let m = 0; for (let k = lo; k < hi && k < bins; k++) m = Math.max(m, spec[k]);
        const hgt = 0.02 + (m / 255) * 1.6;
        this._barP.set((i - n / 2) * 0.11, hgt / 2, -2.2);
        this._barS.set(1, hgt, 1);
        this._barM.compose(this._barP, this._barQ, this._barS);
        this.bars.setMatrixAt(i, this._barM);
      }
      this.bars.instanceMatrix.needsUpdate = true;
    }
    this.renderer.render(this.scene, this.camera);
  }
}

function disposeTree(o) {
  o.traverse(n => {
    if (n.geometry) n.geometry.dispose();
    if (n.material) {
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      for (const m of mats) { for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); } m.dispose(); }
    }
  });
}
