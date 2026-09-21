# Urban Creator CONTROL — Manual Regression Checklist (P0–P7)

Cara pakai: centang `[x]` tiap item setelah lolos. Kolom **Cepat cek kalau gagal**
kasih tempat pertama yang harus dilihat, supaya tidak perlu re-investigasi dari nol.

Hardware yang dipakai:
- **GRBL-1**: mesin GRBL biasa
- **GRBL-2 (UC-100)**: STM32 custom, firmware **GRBL Mythos** — satu-satunya yang
  punya command `$TLS`/`$TCZ`
- **HAL-1 (BluePill)**: grblHAL, USB-CDC

Item flashing firmware ESP32 (BLOX/Interface via esptool) **ditandai OPSIONAL** —
board Anda semua STM32, bukan ESP32.

---

## P0 — DEV Build Isolation

- [ ] **Instalasi berdampingan**: install Urban Creator CONTROL di mesin yang
      juga sudah ada OpenBuilds CONTROL asli. Jalankan KEDUANYA bersamaan.
      **Harapan**: dua proses terpisah di Task Manager, dua tray icon terpisah,
      tidak ada crash/rebutan resource.
      **Cepat cek**: `%APPDATA%\UrbanCreatorCONTROL-dev\` harus ada terpisah dari
      folder OpenBuilds CONTROL asli.
- [ ] **Tray/window identity**: judul window, tray tooltip harus menunjukkan
      "Urban Creator CONTROL" (tanpa suffix "(DEV)" - branding final sejak P8),
      bukan "OpenBuilds CONTROL". AUMID (klik kanan taskbar icon → properties)
      tetap `id.urbancreator.control.dev` - itu ID internal Windows, sengaja
      TIDAK diubah di P8 supaya tidak bentrok dengan install DEV yang sudah ada.
      **Cepat cek**: `npm test` → test `P0: package.json identity...` (otomatis).

## P1 — Serial Port Lifecycle

- [ ] **Connect/disconnect normal (GRBL-1)**: connect, kirim beberapa command,
      disconnect via UI. **Harapan**: port lepas bersih, bisa connect ulang langsung
      tanpa restart app.
- [ ] **Connect/disconnect normal (HAL-1 grblHAL USB-CDC)**: sama seperti di atas.
      **Harapan sama** — USB-CDC kadang lebih sensitif ke close-order, jadi test ini
      WAJIB di grblHAL juga, jangan cuma di GRBL.
- [ ] **Force-close app saat masih connected (GRBL-1)**: connect, lalu tutup app
      dari Task Manager (End Task) TANPA disconnect dulu. Buka app lagi, coba
      connect ke port yang sama.
      **Harapan**: berhasil connect lagi tanpa error "Access Denied"/port busy.
      **Cepat cek**: lihat `serial.log` di userData folder — harus ada baris
      penutupan port terakhir sebelum app mati.
- [ ] **Force-close saat masih connected (HAL-1)**: ulangi test di atas khusus untuk
      grblHAL — USB-CDC yang paling rawan port nyangkut.
- [ ] **Quit via tray/menu saat connected**: connect, lalu quit lewat tray icon
      (bukan force-kill). **Harapan**: port ditutup rapi sebelum app keluar
      (cek `serial.log`).

## P2 — App/Process Lifecycle

- [ ] **Flash firmware lalu force-close saat proses jalan** *(OPSIONAL — hanya kalau
      ada board ESP32; board Anda STM32, boleh skip)*: mulai flash BLOX/Interface,
      force-close app di tengah proses. **Harapan**: proses `esptool.exe` ikut mati
      (cek Task Manager), tidak ada child process nyangkut.
- [ ] **Tray icon & identitas saat menu terbuka**: klik kanan tray icon, screenshot
      menu — pastikan semua teks bilang "Urban Creator CONTROL" (tanpa "(DEV)").

## P3 — Localhost Backend

- [ ] **Port tidak bentrok dengan OpenBuilds asli**: jalankan keduanya bersamaan,
      cek `netstat -ano | findstr "4000 3000"` — harus ada DUA baris LISTENING
      terpisah (4000 untuk DEV, 3000 untuk yang asli), tidak ada yang gagal bind.
- [ ] **CORS/CSRF dari device lain di LAN**: dari laptop/HP lain di WiFi yang sama,
      coba `curl -i -X POST -H "Origin: http://evil.example.com" http://<IP-PC>:4000/runjob`
      **Harapan**: HTTP 403 Forbidden.
      **Cepat cek**: `npm test` → test `rejectCrossOriginStateChanges` (otomatis,
      cuma cek kode-nya ada; test manual ini yang cek BENERAN jalan di jaringan).
- [ ] **Jog-from-Phone masih jalan**: scan QR code dari HP, buka `/jog`, coba jog
      X/Y/Z dari HP. **Harapan**: tetap berfungsi normal (fitur ini sengaja
      TIDAK dibatasi CORS-nya).

## P4 — Security Audit

- [ ] **Tidak ada dialog error TLS aneh saat startup**: buka app, pastikan tidak ada
      crash terkait file `.pem` yang hilang.
      **Cepat cek**: `npm test` → test P4 TLS (otomatis, cek file `dev-selfsigned-*.pem`
      ada, `privkey1.pem`/`fullchain1.pem` OpenBuilds tidak ada).
- [ ] **Tidak ada auto-update popup**: biarkan app terbuka beberapa menit, pastikan
      TIDAK muncul notifikasi "Update Available" apapun.
      **Cepat cek**: buka DevTools (F12) → tab Network → filter "github" — harus
      KOSONG total, tidak ada request keluar ke `api.github.com`/`raw.githubusercontent.com`.

## P5 — Build Reproducibility

- [ ] **Build ulang dari clone bersih** *(kalau sempat)*: `git clone` ke folder baru,
      `npm ci`, `npx electron-builder --win --publish never`. **Harapan**: build
      sukses tanpa error dependency, ukuran installer masuk akal (bandingkan dengan
      build sebelumnya, harusnya mirip).
      **Cepat cek**: `npm test` → semua test P5 (otomatis, cek lockfile ter-track,
      Node version pinned, changelog fetch mati).

## P6 — Machine Profiles (Router/Laser)

- [ ] **Router tidak mengubah setting apapun (GRBL-1)**: connect, catat semua nilai
      $ saat ini (screenshot Advanced Settings), klik profile "Router", cek lagi.
      **Harapan**: TIDAK ADA satupun nilai $ yang berubah di form (sebelum Save).
      **Cepat cek**: `npm test` → `Router profile touches zero settings` (otomatis,
      tapi ini test LOGIKA saja — test manual ini yang konfirmasi UI-nya benar).
- [ ] **Laser set $32=1 dan $44=0, TIDAK sentuh $45 (GRBL-2/UC-100)**: connect,
      catat nilai $45 SAAT INI (penting — sebelum klik apapun), klik profile
      "Laser", cek form: $32 harus jadi 1, $44 harus jadi 0, **$45 harus PERSIS
      sama seperti sebelum diklik** (tidak berubah sedikitpun).
      **Cepat cek**: `npm test` → `Laser profile sets $32=1 and $44=0...` (otomatis).
- [ ] **Laser tidak sentuh setting lain**: setelah klik Laser, cek $21/$22/$30/$33/
      $34/$35/$36 — semua harus tetap seperti sebelum diklik.
- [ ] **Toggle Hard Limit independen dari Homing**: klik toggle Hard Limit ON,
      Homing tetap OFF (dan sebaliknya) — pastikan keduanya benar-benar terpisah,
      tidak saling ikut berubah.
- [ ] **Homing behavior nyata setelah Save (GRBL-2/UC-100, HATI-HATI)**: dengan
      Laser profile + Save to Firmware + reset, coba jalankan Homing ($H).
      **Harapan sesuai keputusan P6/P7**: **Z TIDAK IKUT HOMING** (karena $44=0),
      X/Y homing tergantung nilai $45 yang SUDAH ADA di firmware Anda sebelumnya
      (ini bukan jaminan otomatis dari app — cek dulu manual apakah $45 board
      UC-100 Anda memang berisi mask X+Y sebelum mengandalkan fitur ini).
      **PENTING**: siapkan tombol E-Stop/tangan di dekat mesin untuk test pertama
      kali — kalau X/Y ternyata tidak homing seperti yang diharapkan, itu bukan
      bug app, itu berarti $45 board Anda perlu diset manual dulu.
- [ ] **Backup/restore tetap jalan**: backup settings ke file (.txt), restore dari
      file itu. **Harapan**: semua $ value kembali seperti sebelum backup, toggle
      Hard Limit/Homing ikut ter-highlight sesuai nilai yang di-restore (bukan
      ke-reset ke OFF).
- [ ] **grblHAL-specific settings (HAL-1)**: connect ke grblHAL, cek tab Grbl
      Settings menampilkan label "grblHAL" (bukan "Grbl"), dan setting-setting
      grblHAL-only (mis. $370, $376, $34x) muncul dengan label yang benar di
      Advanced Settings (bukan badge merah "?").

## Jog Controls

- [ ] **8 arah jog mengirim command yang benar (GRBL-1)**: test SEMUA 8 tombol
      (X+, X-, Y+, Y-, X+Y+, X-Y+, X+Y-, X-Y-) satu-satu di mode Incremental
      10mm. **Harapan**: mesin bergerak ke arah yang PERSIS sesuai label tombol
      (terutama X-Y- — ini yang pernah salah ikon arahnya, pastikan gerakan
      FISIK mesin juga benar, bukan cuma ikon).
      **Cepat cek**: `npm test` → `diagonal jog (Incremental mode) sends a
      correctly-signed jogXY...` (otomatis, cek command yang DIKIRIM, tapi test
      manual ini yang konfirmasi mesin BENERAN bergerak arah yang benar).
- [ ] **Continuous diagonal jog + Stop Jog (HAL-1 grblHAL)**: pilih CONT, tahan
      salah satu tombol diagonal sampai mesin bergerak terus, klik **Stop Jog**
      (bukan lepas tombol arah) di tengah gerakan.
      **Harapan**: mesin berhenti SEKETIKA, status tetap Idle (bukan Alarm),
      bisa langsung jog lagi tanpa perlu Unlock Alarm.
- [ ] **Stop Jog saat tidak ada jog aktif**: klik Stop Jog waktu mesin diam.
      **Harapan**: tidak error, tidak crash, tidak ada efek apapun.
- [ ] **Toggle jarak 5-pilihan lengkap terlihat**: buka jendela jog, hitung — harus
      ada 5 tombol (0.1/1/10/100/CONT), semua terlihat penuh, tidak ada yang
      terpotong.
      **PENTING**: test di window **dikecilkan** (~1024px lebar dan lebih pendek
      dari biasanya) — pastikan 5 tombol TETAP semua terlihat dan bisa diklik,
      tidak overlap dengan tab 3D View/Log/Macros di bawahnya (ini bug yang
      pernah kejadian).
- [ ] **Klik tiap tombol jarak berfungsi**: klik satu-satu 0.1→1→10→100→CONT→balik
      ke 10mm. **Harapan**: highlight ORANGE pindah setiap kali, dan jog beneran
      pakai jarak yang dipilih (test minimal 1x jog per pilihan jarak untuk
      konfirmasi bukan cuma visual yang berubah).
- [ ] **Style orange konsisten**: bandingkan warna 4 tombol diagonal (harus orange,
      beda dari X/Y merah-hijau dan Z biru), tombol jarak aktif (orange), Stop Jog
      (orange solid bulat) — semua orange harus warna yang SAMA (tidak ada yang
      beda shade).
- [ ] **Mobile/Jog-from-Phone toggle jarak**: dari HP, cek 5 tombol jarak juga
      muncul lengkap dan berfungsi (diagonal TIDAK ada di mobile, itu memang
      sengaja/desktop-only).

## TLS/TCZ (khusus firmware GRBL Mythos — GRBL-2/UC-100)

- [ ] **Posisi & jarak visual tombol**: buka panel DRO, pastikan tombol TLS/TCZ
      ada di TENGAH kolom (bukan mepet kiri), dengan garis pemisah + jarak jelas
      dari tombol Set Zero X/Y/Z/XYZ di atasnya — coba klik Set Zero XYZ dulu,
      pastikan TIDAK sengaja kepencet TLS/TCZ karena posisinya terlalu dekat.
- [ ] **TLS sukses**: jog manual ke posisi toolsetter fisik, klik TLS.
      **Harapan**: muncul respons di console/log (baik sukses atau pesan
      `[MSG:TLS NOT SAVED: ...]` kalau posisi tidak valid — coba dari posisi di
      luar travel untuk memicu ini).
- [ ] **TCZ gagal — Homing ON**: set toggle Homing = ON ($22=1), klik TCZ.
      **Harapan**: muncul `[MSG:TCZ FAIL: HOMING ENABLED...]` di log, TIDAK crash.
- [ ] **TCZ gagal — belum TLS**: Homing OFF, tapi belum pernah klik TLS sejak
      firmware nyala/reset, klik TCZ.
      **Harapan**: muncul `[MSG:TCZ FAIL: RUN $TLS FIRST]`.
- [ ] **TCZ sukses**: Homing OFF, TLS sudah dijalankan, jog ke Z aman, klik TCZ.
      **Harapan**: firmware terima tanpa pesan error.
- [ ] **Tidak crash dalam skenario manapun**: ulangi TLS/TCZ berkali-kali gantian
      dengan mode Homing ON/OFF secara acak — app tidak boleh freeze/crash
      sekalipun firmware selalu menolak.

---

## P9 — Job Recovery (disimpan di server, bukan localStorage)

Data recovery ada di `%APPDATA%\UrbanCreatorCONTROL-dev\job-recovery.json`
(file kecil, boleh dibuka dengan Notepad untuk mengintip `state` dan
`resumeLine`). **Pakai G-code yang punya baris kosong + komentar `;` + beberapa
`M3/G21/G90/T`** — justru di file seperti itu nomor baris versi lama melenceng.
Cara cek "baris yang benar": buka G-code di tab GCODE Editor, catat baris yang
sedang disorot saat Anda cabut USB, bandingkan dengan `resumeLine`.

- [ ] **Cabut USB di tengah job → restart app**: jalankan job, cabut USB paksa
      di tengah jalan, tutup app, buka lagi. **Harapan**: dialog "Unfinished job
      found" muncul (setelah splash hilang), menampilkan nama file yang benar
      dan `resumeLine` yang berdekatan dengan posisi sebenarnya. `state` di file
      = `running`/`interrupted` (bukan `stopped`).
- [ ] **Nomor baris = baris SUMBER, bukan indeks antrean**: pada file uji
      di atas, `resumeLine` harus cocok dengan nomor baris di editor, TIDAK
      melenceng beberapa baris ke depan (perilaku lama).
- [ ] **Cek arah kesalahan**: `resumeLine` harus sama dengan atau SEDIKIT SEBELUM
      posisi mesin berhenti — tidak boleh lebih jauh dari itu. (Kalau lebih jauh,
      hasil recovery akan MELEWATI bagian yang belum dipotong — ini kegagalan.)
- [ ] **Recover job**: klik "Recover job" → wizard 2 langkah terbuka dengan
      "Start from line" sudah terisi `resumeLine`, catatan file/waktu tampil,
      dan (kalau firmware melaporkan) peringatan kedalaman planner.
- [ ] **Job selesai normal → data terhapus**: jalankan job pendek sampai selesai
      (M30). **Harapan**: `job-recovery.json` hilang begitu mesin kembali Idle
      (bukan saat baris terakhir terkirim — lihat file berstatus `completing`
      selama gerakan terakhir masih berjalan, lalu hilang). Restart app →
      TIDAK ada dialog recovery.
- [ ] **Cabut USB tepat di gerakan terakhir** (setelah baris terakhir terkirim,
      sebelum mesin berhenti): file harus TETAP ada dengan baris di dekat akhir
      file — bukan baris 1.
- [ ] **Tombol Stop**: jalankan job, tekan Stop. **Harapan**: file TETAP ada
      dengan `state: stopped` (disengaja — ini kasus "mata bor patah → Stop →
      ganti → lanjutkan"). Restart app → dialog muncul, teks "The job was stopped".
- [ ] **Discard**: pilih "Discard" di dialog → file terhapus, restart app tidak
      menawarkan lagi. "Later" → file tetap ada.
- [ ] **File salah**: buka G-code LAIN, klik Recover Job. **Harapan**: peringatan
      merah "The loaded file is X, not Y". Kalau file lebih pendek dari
      `resumeLine`: peringatan + mulai dari baris 1.
- [ ] **Jog & probing tidak menimpa data**: setelah ada data recovery, jalankan
      jog/probing/bbox (`isJob:false`) — isi file TIDAK berubah.
- [ ] **Halaman Jog-from-Phone**: buka dari HP saat ada data recovery —
      TIDAK ada dialog di HP.
- [ ] **Job berjalan + reload renderer (F5)**: tekan F5 di tengah job.
      **Harapan**: TIDAK muncul dialog recovery untuk job yang sedang jalan.
- [ ] **Nama file berisi karakter aneh** (`a'b&c.nc`, kutip, `&`): dialog
      menampilkannya apa adanya, tanpa merusak tampilan.

### P9 — State basi setelah antrean dibuang (cabut USB / Stop / Clear Alarm)

Bug asal: setelah USB dicabut di tengah job lalu Connect lagi, perintah PERTAMA
yang dikirim klien (`$$`) tidak pernah sampai ke controller, dan log palsu
`[ JOB COMPLETE ] Job completed in 00h00m` muncul + entri kotor masuk riwayat job.

- [ ] **Cabut USB di tengah job → Connect lagi**: **Harapan**: TIDAK ada baris
      `[ JOB COMPLETE ]` di log. Dump `$$` (pengaturan) tampil lengkap tepat
      setelah connect — baris pertama tidak hilang.
- [ ] **Riwayat job mencatat job yang terputus — tepat SATU kali, akurat**:
      setelah skenario di atas, buka statistik job (Job Stats / "Log: Jobs").
      **Harapan**: ada SATU entri baru bertanda ✗ merah (tidak selesai) untuk
      job yang dicabut, dengan jam mulai = saat job dijalankan dan durasi
      "(Streamed)" ≈ lama job berjalan SEBELUM USB dicabut (bukan sampai Anda
      menekan Connect). Setelah Connect + perintah lain: TIDAK bertambah entri
      lagi (tidak ada entri kedua/palsu).
- [ ] **Stop di tengah job → riwayat**: satu entri ✗ dengan waktu berhenti =
      saat Stop ditekan. Tidak ada log `[ JOB COMPLETE ]`.
- [ ] **Alarm → Clear Alarm/Reset (metode yang mengosongkan antrean) → riwayat**:
      satu entri ✗. Clear Alarm biasa (`$X` saja) TIDAK menambah entri.
- [ ] **Tidak ada entri untuk yang bukan job**: kirim perintah di console
      (`$$`, `$G`), jog, probing — lalu putuskan koneksi. Riwayat tidak berubah.
- [ ] **Job yang sudah selesai dikirim lalu di-Stop**: jalankan job pendek dan
      tekan Stop SETELAH baris terakhir terkirim (saat mesin masih menyelesaikan
      gerakan). Entri tetap ✓ (sudah tercatat selesai saat baris terakhir
      terkirim); tidak muncul entri ✗ tambahan.
- [ ] **Job BARU tepat setelah reconnect mulai dari baris 1**: Connect lagi lalu
      SEGERA (sebelum 1-2 detik) jalankan job. **Harapan**: gerakan/baris pertama
      = baris pertama file (header G21/G90/spindle tetap dijalankan), bukan
      melompat ke tengah file. Perhatikan kursor editor saat job mulai.
- [ ] **Stop di tengah job → kirim perintah apa saja** (mis. `$G` di console):
      TIDAK ada `[ JOB COMPLETE ]` palsu.
- [ ] **Alarm di tengah job → Clear Alarm/Reset (metode yang mengosongkan
      antrean) → kirim perintah**: TIDAK ada `[ JOB COMPLETE ]` palsu.
- [ ] **Job selesai normal TETAP dicatat**: jalankan job pendek sampai selesai.
      **Harapan**: `[ JOB COMPLETE ] Job completed in ...` muncul SEKALI dan
      entri "complete" masuk riwayat job (fix tidak boleh mematikan ini).

---

## Ringkasan: Area Paling Berisiko (prioritaskan waktu review di sini)

1. **🔴 Laser profile homing behavior ($44/$45)** — ini SATU-SATUNYA test di
   seluruh daftar yang bergantung pada ASUMSI (nilai $45 firmware Anda sudah
   berisi mask X+Y), bukan sesuatu yang app jamin. Kalau dilewati, risikonya
   Z bisa ikut/tidak ikut homing dengan cara yang tidak terduga — **test ini di
   UC-100 dengan tangan siap di E-Stop sebelum dipakai kerja beneran.**
2. **🔴 Force-close port di grblHAL USB-CDC** — dari histori P1, USB-CDC lebih
   rawan port nyangkut dibanding chip serial biasa. Kalau cuma test di GRBL dan
   skip grblHAL, bisa lolos padahal grblHAL-nya masih bermasalah.
3. **🟠 Toggle jarak jog di window kecil** — ini murni bug regresi yang PERNAH
   terjadi (overlap dengan tab bar). Kalau hanya ditest di window full-screen,
   bug serupa bisa lolos tanpa ketahuan.
4. **🟠 CORS/CSRF dari device LAN lain** — automated test cuma cek KODE-nya ada,
   bukan bahwa server BENERAN menolak di jaringan asli. Ini satu-satunya test
   security yang perlu 2 perangkat fisik untuk benar-benar diverifikasi.
5. **🟡 TLS/TCZ error-handling** — firmware-dependent (Mythos custom), automated
   test tidak bisa menjangkau ini sama sekali (butuh hardware nyata + firmware
   spesifik Anda) — kalau dilewati, tidak ada jaring pengaman otomatis apapun.

Semua yang TIDAK masuk daftar di atas sudah punya automated test yang jalan tiap
`npm test` — kalau waktu terbatas, boleh percaya ke automated test untuk P0/P3/P4/P5/
struktur-P6 dan fokus waktu manual ke 5 area di atas.
