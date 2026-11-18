(function () {
  "use strict";

  // 1. DYNAMIC DEPENDENCY LOADER (GLTFLoader + mp4-muxer)
  function loadScript(src, timeoutMs = 4000) {
    return new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = src;
      const t = setTimeout(() => resolve(false), timeoutMs);
      s.onload = () => { clearTimeout(t); resolve(true); };
      s.onerror = () => { clearTimeout(t); resolve(false); };
      document.head.appendChild(s);
    });
  }

  // 2. SMART CACHE FETCH LOGIC (Pulls from Worker)
  async function fetchScenePayload() {
    const fallback = { title: "Kinetra3D Cinema", narration: "", atmosphere: "studio_clean", code: "" };
    const urlObj = new URL(window.location.href);
    const sceneId = urlObj.searchParams.get("id");
    
    if (sceneId) {
      try {
        // Fetch the raw code from our Cloudflare Worker Cache
        const res = await fetch(`https://ai-3d-video-studio-mcp.kinetra3d.workers.dev/scene?id=${encodeURIComponent(sceneId)}`);
        if (res.ok) {
          const data = await res.json();
          return { ...fallback, ...data };
        }
      } catch (e) { console.error("Worker fetch failed", e); }
    }
    return fallback;
  }

  // 3. AI CODE WASHER
  function sanitizeAICode(rawCode) {
    if (typeof rawCode !== "string") return "";
    return rawCode
      .replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "")
      .replace(/import\s+.*?from\s+['"].*?['"]\s*;?/g, "")
      .replace(/(?:const|let|var)\s+scene\s*=\s*new\s+THREE\.Scene\s*\([^)]*\)\s*;?/g, "")
      .replace(/(?:const|let|var)\s+camera\s*=\s*new\s+THREE\.PerspectiveCamera\s*\([^)]*\)\s*;?/g, "")
      .replace(/(?:const|let|var)\s+renderer\s*=\s*new\s+THREE\.WebGLRenderer\s*\([^)]*\)\s*;?/g, "")
      .replace(/document\.body\.appendChild\s*\([^)]*\)\s*;?/g, "")
      .trim();
  }

  // 4. OFFLINE AUDIO MASTERING
  async function buildAudioTrack(narrationText) {
    const text = (narrationText || "").replace(/\[.*?\]/g, " ").trim();
    if (!text) return { durationSec: 15, fps: 30, totalFrames: 450, lipEnvelope: new Float32Array(450), buffer: null };

    const sampleRate = 44100;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    
    const isHindi = /[\u0900-\u097F]/.test(text);
    const url = `https://text.pollinations.ai/${encodeURIComponent("Speak dynamically: " + text)}?model=openai-audio&voice=${isHindi ? "onyx" : "echo"}`;
    
    let audioBuf = null;
    try {
      const res = await fetch(url);
      const arr = await res.arrayBuffer();
      audioBuf = await ctx.decodeAudioData(arr);
    } catch(e) {}
    
    const durationSec = Math.max(12, Math.min(24, audioBuf ? Math.ceil(audioBuf.duration + 1) : 15));
    const offline = new OfflineAudioContext(2, Math.ceil(sampleRate * durationSec), sampleRate);
    
    // Background Pad + Voice Mixing
    const pad = offline.createOscillator(); pad.frequency.value = 98;
    const padGain = offline.createGain(); padGain.gain.value = 0.01;
    pad.connect(padGain); padGain.connect(offline.destination);
    pad.start(0);

    if (audioBuf) {
      const src = offline.createBufferSource();
      src.buffer = audioBuf;
      const comp = offline.createDynamicsCompressor();
      const boost = offline.createGain(); boost.gain.value = 2.0;
      src.connect(comp); comp.connect(boost); boost.connect(offline.destination);
      src.start(0.5);
    }

    const rendered = await offline.startRendering();
    
    const fps = 30;
    const totalFrames = durationSec * fps;
    const lip = new Float32Array(totalFrames);
    if (audioBuf) {
      const ch = rendered.getChannelData(0);
      const spf = Math.floor(sampleRate / fps);
      for(let f=0; f<totalFrames; f++) {
        let sum = 0;
        for(let s=f*spf; s<(f+1)*spf; s+=8) sum += ch[s]*ch[s];
        lip[f] = Math.min(1, Math.sqrt(sum / (spf/8)) * 6.0);
      }
    }
    return { durationSec, fps, totalFrames, lipEnvelope: lip, buffer: rendered };
  }

  // 5. MAIN STUDIO ENGINE
  async function startStudio() {
    document.getElementById("uiStatus").textContent = "Loading WebGL & Encoders...";
    await Promise.all([
      loadScript("https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js", 3000),
      loadScript("https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.js", 3000)
    ]);

    const sceneData = await fetchScenePayload();
    document.getElementById("uiTitle").textContent = sceneData.title || "Kinetra3D Studio";
    document.getElementById("uiStatus").textContent = "Synthesizing AI Voice...";

    const audioTrack = await buildAudioTrack(sceneData.narration);

    const WIDTH = 1280, HEIGHT = 720;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(WIDTH, HEIGHT);
    renderer.shadowMap.enabled = true;
    renderer.outputEncoding = THREE.sRGBEncoding;
    document.getElementById("previewContainer").insertBefore(renderer.domElement, document.getElementById("previewContainer").firstChild);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111827); // Dark base background
    const camera = new THREE.PerspectiveCamera(44, 16/9, 0.1, 300);
    camera.position.set(0, 2.2, 6.5);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x1e293b, 0.8);
    const dir = new THREE.DirectionalLight(0xfff8eb, 1.2);
    dir.position.set(5, 10, 7); dir.castShadow = true;
    scene.add(hemi, dir);

    const mixers = [];
    const pendingLoads = [];

    // STUDIO API: Dynamic GLB Loader (No Repo Uploads Needed)
    const Studio = {
      loadGLB: function(url, opts = {}) {
        const group = new THREE.Group();
        group.position.set(opts.x||0, opts.y||0, opts.z||0);
        if (opts.ry) group.rotation.y = opts.ry;
        scene.add(group);

        if (THREE.GLTFLoader) {
          const p = new Promise(resolve => {
            new THREE.GLTFLoader().load(url, (gltf) => {
              const m = gltf.scene;
              m.scale.setScalar(opts.scale || 1.0);
              group.add(m);
              if (gltf.animations.length > 0) {
                const mixer = new THREE.AnimationMixer(m);
                mixer.clipAction(gltf.animations[0]).play();
                mixers.push(mixer);
              }
              resolve();
            }, undefined, resolve);
          });
          pendingLoads.push(p);
        }
        return group;
      }
    };
    window.Studio = Studio;

    // Run AI Code
    if (sceneData.code && sceneData.code.length > 10) {
      try {
        const buildFn = new Function("scene", "camera", "renderer", "THREE", "Studio", sanitizeAICode(sceneData.code));
        buildFn(scene, camera, renderer, THREE, Studio);
      } catch(e) { console.error("AI Logic Error:", e); }
    }

    await Promise.all(pendingLoads);

    // Auto Camera if AI didn't provide one
    if (typeof window.animateScene !== "function") {
      window.animateScene = (t, p) => {
        const a = p * Math.PI - 0.5;
        camera.position.set(Math.sin(a)*6, 2.5, Math.cos(a)*6);
        camera.lookAt(0,1,0);
      };
    }

    // 6. FAST MP4 EXPORT
    document.getElementById("uiStatus").textContent = "Rendering True MP4 Video...";
    const { totalFrames, fps, buffer, lipEnvelope } = audioTrack;
    
    function renderFrame(f) {
      const t = f/fps;
      mixers.forEach(m => m.update(1/fps));
      try { window.animateScene(t, f/totalFrames); } catch(e){}
      renderer.render(scene, camera);
    }

    let finalBlob = null;
    try {
      const muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: "avc", width: WIDTH, height: HEIGHT },
        audio: buffer ? { codec: "aac", numberOfChannels: 2, sampleRate: buffer.sampleRate } : undefined,
        fastStart: "in-memory"
      });

      const vEnc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: console.error });
      vEnc.configure({ codec: "avc1.42001f", width: WIDTH, height: HEIGHT, bitrate: 4000000, framerate: fps });

      let aEnc = null;
      if (buffer) {
        aEnc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: console.error });
        aEnc.configure({ codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: buffer.sampleRate, bitrate: 128000 });
        const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
        for (let o=0; o<buffer.length; o+=1024) {
          const l = Math.min(1024, buffer.length-o);
          const p = new Float32Array(l*2);
          p.set(left.subarray(o, o+l), 0); p.set(right.subarray(o, o+l), l);
          const ad = new AudioData({ format: "f32-planar", sampleRate: buffer.sampleRate, numberOfFrames: l, numberOfChannels: 2, timestamp: Math.round(o/buffer.sampleRate*1e6), data: p });
          aEnc.encode(ad); ad.close();
        }
        await aEnc.flush();
      }

      for (let f=0; f<totalFrames; f++) {
        renderFrame(f);
        const vf = new VideoFrame(renderer.domElement, { timestamp: Math.round(f/fps*1e6), duration: Math.round(1/fps*1e6) });
        vEnc.encode(vf, { keyFrame: f%30===0 });
        vf.close();
        if (f%15===0) {
          document.getElementById("uiProgress").style.width = Math.floor(f/totalFrames*100) + "%";
          await new Promise(r=>setTimeout(r, 0));
        }
      }

      await vEnc.flush();
      muxer.finalize();
      finalBlob = new Blob([muxer.target.buffer], { type: "video/mp4" });
    } catch(e) { console.error("MP4 Error", e); }

    // Display & Download Setup
    if (finalBlob) {
      document.getElementById("renderHud").style.display = "none";
      document.getElementById("uiBadge").textContent = "READY";
      document.getElementById("uiBadge").classList.add("ready");
      
      const url = URL.createObjectURL(finalBlob);
      const btn = document.getElementById("uiDownloadBtn");
      btn.href = url;
      btn.download = "kinetra3d_video.mp4";
      btn.textContent = "Download MP4";
      btn.classList.remove("locked");

      const p = document.getElementById("finalPlayer");
      p.src = url; p.style.display = "block";
      renderer.domElement.style.display = "none";
      p.play().catch(()=>{});
    }
  }

  startStudio();
})();
