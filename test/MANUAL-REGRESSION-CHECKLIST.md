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
- [ ] **Start from Line setelah crash**: klik ribbon "Start from Line" (file yang sama
      sudah dimuat) → dialog "Lanjutkan dari Baris" terbuka dengan baris terisi
      `resumeLine` - 10 dan Safe Height 10 mm.
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
      ganti → lanjutkan"). Restart app → TIDAK ada notifikasi otomatis (state
      `stopped` tidak ditawarkan otomatis); ribbon "Start from Line" tetap
      mengisi baris dari catatan itu.
- [ ] **Menutup notifikasi tidak menghapus data**: tutup banner/modal dengan (x) atau
      "Tutup / Close" → file `job-recovery.json` TETAP ada; tombol ribbon masih
      mengisi baris yang sama. (UI tidak pernah menghapus catatan; hanya job baru
      atau job selesai yang menggantinya.)
- [ ] **File berbeda**: buka G-code LAIN (nama berbeda dari catatan), klik Start from
      Line. **Harapan**: dialog terbuka di baris 1 (bukan baris catatan), tanpa
      peringatan/catatan soal file lain dan tanpa dialog pilih file.
- [ ] **Highlight editor mengikuti baris file asli**: jalankan job penuh lalu job
      dari "Start from Line" (mis. baris 1500 dari file 1654 baris). **Harapan**:
      baris aktif di tab GCODE Editor bergerak di sekitar baris file yang sebenarnya
      (mulai ~baris 1493-1500 lalu maju), BUKAN angka kecil ~130. Untuk jog/probing/
      bounding box (bukan job) kursor editor boleh bergerak seperti sebelumnya.
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

### P9 — Notifikasi recovery (hanya informasi) dan dialog "Lanjutkan dari Baris"

> **Notifikasi otomatis (banner saat reconnect, modal saat app dibuka) HANYA INFORMASI.** Tidak ada
> tombol yang membuka Start from Line. Menutupnya ((x) atau "Tutup / Close") TIDAK menghapus data recovery.
> Jalan masuknya: tombol ribbon **Start from Line** (kapan saja, dengan atau tanpa data crash; syarat: ada
> file G-code di editor) atau klik kanan baris → "Recover job from Line" di GCODE Editor. Keduanya membuka
> dialog **Lanjutkan dari Baris / Start From Line** yang SAMA.
>
> Tombol akhir dialog ("Mulai dari Baris Ini") **LANGSUNG MENJALANKAN MESIN** sebagai SATU job (tidak ada
> klik Run kedua): Z naik → spindle nyala → gerak cepat ke titik awal → turun → potong dari baris N.
> **Tes TANPA mata bor dan tanpa benda kerja, siap menekan Stop.**

- [ ] **Banner saat reconnect**: cabut USB di tengah job, sambung lagi (app tetap terbuka). Banner kiri-bawah
      muncul SETELAH controller teridentifikasi: "Pekerjaan terhenti di baris X dari Y total baris. Disarankan
      mulai sekitar baris X-10 setelah Home dan Set Zero ulang." + nama file + petunjuk ribbon. **Tidak ada
      tombol aksi**, hanya (x). Bukan modal (Stop/jog tetap bisa). Tutup dengan (x) → data TETAP ada:
      tombol ribbon Start from Line masih menemukannya.
- [ ] **Modal saat app dibuka** (ada rekaman crash): teks sama, hanya "Tutup / Close" dan (x). Menutupnya
      tidak menghapus data (buka app lagi → muncul lagi, sampai job baru dijalankan/selesai).
- [ ] **Sekali per rekaman**: tutup banner, lalu Disconnect + Connect lagi (app tidak di-restart) → banner
      TIDAK muncul lagi. Job baru yang terputus → muncul lagi. Rekaman `stopped` (Stop manual) → TIDAK ada
      banner (hanya lewat ribbon).
- [ ] **Isi dialog** (klik ribbon Start from Line dengan data crash): judul "Lanjutkan dari Baris" / "Start From
      Line"; deskripsi; "Pekerjaan Anda (total Y baris) terhenti sekitar baris X"; "Disarankan mulai sekitar
      baris X-10"; input "Mulai dari baris:" TERISI X-10 dan bisa diedit; "Safe Height (Z), mm:" terisi 10;
      ringkasan "Z akan naik ke Zxx ... Urutan sebelum baris N: Z ke ... → spindle ... → gerak cepat ke X.. Y..
      → turun ke Z.. (F..) → feed F.."; kotak ORANYE "Mesin akan LANGSUNG bergerak begitu tombol di bawah
      diklik"; catatan Home/Set Zero; tombol "Mulai dari Baris Ini / Start from Line".
- [ ] **Validasi**: baris di luar 1..Y, kosong, atau Safe Height di luar 0..500 → tombol abu-abu + pesan
      merah. Mesin tidak terhubung/tidak idle (atau job berjalan) → abu-abu dalam ~0,5 detik. Baris yang
      tidak bisa dilanjutkan (memotong tanpa kata F di mana pun sebelumnya) → abu-abu + alasan.
- [ ] **PALING PENTING — satu klik, satu job, dari baris N, DITERIMA controller**: klik "Mulai dari Baris
      Ini". **Harapan**: dialog menutup; mesin LANGSUNG menaikkan Z, menyalakan spindle, bergerak cepat ke
      titik awal baris N, turun, lalu memotong dari baris N — tanpa menekan Run lagi. TIDAK ada error di
      log/toast (dulu error:22 / error:33 pada baris pertama yang berupa busur tanpa F). Uji dengan file
      yang BANYAK BUSUR (G2/G3) dan perintah spindle-nya (`S16000M3`) SETELAH gerakan pertama (file Endcap).
      Log: "GCODE from line N sent to backend". Baris-baris yang sudah selesai TIDAK dikirim ulang.
- [ ] **Tampilan TETAP/PINDAH KE 3D View**: setelah tombol akhir diklik, layar berada di tab **3D View**
      (tidak pindah ke GCODE Editor atau Log/Serial Console) sehingga gerakan Z naik dan mesin terlihat
      langsung. Dari tab lain (mis. klik kanan di GCODE Editor) → layar berpindah KE 3D View. Tombol Stop di
      ribbon tetap terlihat dan berfungsi; tekan untuk memastikan berhenti seketika.
- [ ] **Klik ganda**: klik cepat dua kali pada tombol akhir → hanya SATU job terkirim.
- [ ] **Klik kanan → "Recover job from Line"**: dialog sama, terisi baris yang diklik - 10, teks "Anda memilih
      baris N". **Ribbon tanpa data crash**: dialog terbuka, terisi baris kursor/scroll, "Anda bebas mulai dari
      baris mana pun". Ribbon tanpa file sama sekali: pesan "Buka file G-code dulu".
- [ ] **File belum dimuat** (app baru, editor kosong, ada data crash): ribbon Start from Line → pesan "Buka file G-code dulu"
      (TIDAK ada dialog pilih file). Buka file lalu klik lagi → dialog terbuka. Ada data crash untuk file LAIN /
      ejaan nama beda → dialog tetap terbuka (mulai baris 1) dengan catatan bahwa data tersimpan diabaikan.
- [ ] **Tanpa data crash sama sekali**: ribbon Start from Line dengan file dimuat → dialog yang sama (baris 1,
      Safe Height 10 mm), TIDAK pernah membuka dialog browse file.
- [ ] **File khusus**: file inci (G20) → Z naik benar; file G91 (inkremental) → tombol abu-abu dengan pesan;
      file tanpa Z → Z naik = Safe Height.
- [ ] **Job dihentikan alarm lalu Clear Alarm**: data recovery TETAP ADA (dulu terhapus sebagai "completed").
- [ ] **Setelan mundur (opsional)**: di console developer `localStorage.setItem('recoveryRewindLines','25')`,
      buka dialog → terisi X-25.

---

## P10 — Tool-Change Wizard (Tahap 1a — mode Pause)

Saat job streaming menemukan baris M6 (tool change), antrean berhenti tepat di
situ — baris M6 **TIDAK PERNAH dikirim ke controller** (jadi jalan di firmware
GRBL/grblHAL standar apa pun, tidak butuh fitur manual-toolchange `$341`).
Setelah controller benar-benar Idle (bukan langsung saat M6 tercapai — masih
menyelesaikan gerakan sebelumnya dulu), dialog "Tool Change" muncul dengan satu
tombol Continue. **Tahap 1a baru mode Pause saja** — belum ada langkah
jog/probe otomatis di dalam dialognya (itu rencana Tahap 1b: Ignore + Standard
Re-zero). Data recovery tetap di `job-recovery.json` seperti P9 di atas — tidak
ada field/skema baru untuk fitur ini.

- [ ] **Job normal dengan M6 di tengah**: jalankan, tunggu dialog Tool Change
      muncul (bukan seketika M6 tercapai — beri jeda sampai mesin benar-benar
      berhenti bergerak dulu), klik Continue. **Harapan**: job lanjut dari
      baris setelah M6 dengan modal (G54/G90/unit/dll.) tetap benar, tidak ada
      gerakan aneh atau lompatan posisi.
- [ ] **Tutup aplikasi (atau kill proses) PERSIS saat dialog tampil**, buka
      lagi. **Harapan**: "Recover Job" menawarkan `resumeLine` = baris M6 itu
      sendiri (bukan sebelum/sesudahnya), dan memilih recover dari baris itu
      memicu ulang dialog Tool Change yang sama dengan wajar.
- [ ] **Cabut USB PERSIS saat dialog tampil**: sama seperti di atas, ditambah
      pastikan reconnect ke port yang sama tidak meninggalkan state nyangkut
      (tombol Pause otomatis enabled lagi setelah reconnect, bukan tetap
      abu-abu selamanya).
- [ ] **Coba tekan tombol Pause manual SAAT dialog tampil**: tombolnya harus
      terlihat disabled (abu-abu) di UI. **Cepat cek**: kalau entah bagaimana
      masih bisa diklik, server tidak boleh mengirim apa pun ke controller
      (lihat serial log) — `pause()` menolak selama menunggu tool change.
- [ ] **M6 sebagai baris PALING TERAKHIR di file**: pastikan dialog Tool
      Change tetap muncul, BUKAN malah dianggap "Job Complete".
- [ ] **Dua (atau lebih) M6 dalam satu job**: dialog harus muncul lagi dengan
      benar untuk tool change kedua, tidak nyangkut setelah yang pertama
      selesai diklik Continue.
- [ ] **Job TANPA M6 sama sekali**: pastikan tidak ada regresi ke perilaku
      streaming biasa — job jalan normal dari awal sampai selesai, tombol
      Pause/Resume manual tetap bekerja seperti sebelum fitur ini ada.
- [ ] **Pause/Resume manual biasa** (job tanpa tool change sama sekali)
      sebelum & sesudah kerja ini: pastikan tidak ada regresi ke fitur yang
      sudah ada.
- [ ] **Clear Alarm (method 2) dipicu SAAT dialog tampil** (mis. limit switch
      kesenggol saat user menjog mesin untuk mengganti tool): alarm ter-clear
      normal DAN state tool-change ikut bersih (dialog tidak nyangkut,
      Pause/tombol lain kembali normal).
      **Cepat cek**: `npm test` → `test/toolchange-state-reset.test.js`
      (otomatis, cek logikanya; test manual ini yang konfirmasi UI/hardware
      beneran begitu).
- [ ] **Reload halaman/renderer (F5, atau semacamnya) SAAT dialog tampil** —
      lihat **known limitation** di bawah sebelum menganggap ini bug.

**Known limitation (BUKAN action item — sudah diketahui dan sengaja ditunda ke
Tahap 1b):** kalau renderer di-reload persis saat dialog Tool Change sedang
tampil, dialognya **hilang dari layar dan tidak muncul otomatis lagi** — event
`toolChangeWizard` dari server sekali-tembak (`toolChangeWizardEmitted`), jadi
tidak dikirim ulang hanya karena halaman dimuat ulang. **Job TIDAK rusak**:
server tetap menahan di `awaitingToolChange=true` dengan aman (tombol Pause
tetap disabled, tidak ada baris yang salah kirim ke controller). Jalan
keluarnya: **Stop → Recover Job** seperti skenario "tutup aplikasi"/"cabut USB"
di atas. Kalau ini terjadi saat validasi, itu perilaku yang SUDAH DIKETAHUI,
bukan temuan baru untuk dilaporkan sebagai bug.

---

## P11 — Fixed Tool Sensor (Tahap 1b-ii)

> **⚠️ PERINGATAN: fitur ini menggerakkan mesin OTOMATIS tanpa konfirmasi tiap
> langkah** (G53 ke lokasi sensor, probe G38.2, kembali). **WAJIB tes pertama
> kali TANPA endmill terpasang (collet kosong) atau dengan Z safety clearance
> maksimal, dan WAJIB tangan siap di tombol E-Stop/Abort sepanjang sequence
> berjalan, sampai terbukti aman berkali-kali.**

Mode M6 ketiga (selain Pause dan Ignore): saat job streaming menemukan baris
M6, antrean berhenti tepat di situ (sama seperti mode Pause — baris M6 **TIDAK
PERNAH dikirim ke controller**), tapi dialognya adalah "Probe & Continue",
bukan "Continue" biasa. Begitu diklik, server menjalankan sequence probe
otomatis: pindah ke lokasi sensor (koordinat mesin) → probe G38.2 → untuk
tool PERTAMA dalam job, hanya menyimpan baseline (tanpa G10, work-origin Anda
tidak disentuh) → untuk tool BERIKUTNYA, menerapkan kompensasi G10 L20 →
kembali ke posisi semula → job lanjut otomatis. Lokasi sensor disimpan per-PC
(localStorage client), bukan di firmware.

- [ ] **Lokasi sensor BELUM di-set → tombol/opsi fixedToolSensor harus menolak
      dengan jelas, TIDAK gerak ke 0,0,0**: pilih mode fixedToolSensor tanpa
      pernah klik "Jadikan Posisi Saat Ini sebagai Lokasi Sensor", jalankan job
      dengan M6. **Harapan**: begitu diklik "Probe & Continue" (atau tombolnya
      memang sudah disabled/menampilkan peringatan sebelum itu), mesin TIDAK
      bergerak sama sekali ke arah manapun, muncul pesan error yang jelas
      (lihat Log/Serial Console: "Lokasi sensor belum diatur...").
      **Cepat cek**: `npm test` → `startToolSensorProbe() refuses when no
      sensor location is configured...` (otomatis, cek logikanya; test manual
      ini yang konfirmasi mesin BENERAN diam).
- [ ] **Soft limits ($20) OFF → tombol capture/probe harus disabled di
      client**: set `$20=0`, buka pengaturan Fixed Tool Sensor. **Harapan**:
      tombol "Jadikan Posisi Saat Ini sebagai Lokasi Sensor" benar-benar
      ter-disable (bukan cuma tooltip peringatan), dengan catatan merah
      "Aktifkan Soft Limits ($20) dulu...". Set `$20=1`, buka lagi → tombol
      aktif normal.
- [ ] **Sequence normal end-to-end**: job dengan DUA M6 (tool berbeda), mode
      fixedToolSensor, lokasi sensor sudah di-set dan Soft Limits ON.
      Jalankan sampai M6 pertama, klik "Probe & Continue". **Harapan tool
      pertama (baseline)**: mesin pindah ke lokasi sensor, probe menyentuh,
      TIDAK ada gerakan G10 (lihat Log: tidak ada baris `G10`), mesin kembali
      ke posisi semula, job lanjut otomatis tanpa klik apapun lagi. Lanjutkan
      sampai M6 kedua, ganti tool fisik, klik "Probe & Continue" lagi.
      **Harapan tool kedua (kompensasi)**: urutan sama, TAPI kali ini ADA
      baris `G10 L20 P..` di Log sebelum mesin kembali — dan hasil potongan
      di Z pada posisi yang sama secara fisik seperti kalau tool pertama yang
      dipakai (test paling meyakinkan: dua tool dengan panjang BERBEDA jelas,
      cek permukaan potong tetap rata/sejajar, tidak ada lompatan Z).
- [ ] **Probe GAGAL (sensor tidak tersentuh dalam jarak 25mm)**: pindahkan
      posisi sensor secara sengaja (edit lokasi tersimpan jadi jauh dari
      sensor fisik, atau angkat sensor fisiknya), klik "Probe & Continue".
      **Harapan**: controller ALARM (G38.2 gagal menyentuh), sequence
      berhenti TOTAL — TIDAK ada G10, TIDAK kembali ke posisi semula secara
      otomatis, TIDAK lanjut job dengan asumsi sukses. Job tetap berstatus
      menunggu (awaitingToolChange) sampai Anda Clear Alarm secara manual.
- [ ] **Tekan Stop/Abort SAAT sequence sedang bergerak** (di tengah gerakan
      G53 menuju sensor, ATAU di tengah gerakan probe G38.2 itu sendiri — coba
      keduanya secara terpisah, di dua percobaan berbeda): **Harapan**: mesin
      benar-benar berhenti SEKETIKA, TIDAK ada gerakan residual/lanjutan
      setelah Stop ditekan (perhatikan dengan teliti — terutama kalau Stop
      ditekan di tengah G38.2, pastikan tidak ada gerakan probe susulan).
- [ ] **Cabut USB/tutup app SAAT sequence berjalan → reconnect**: cabut USB
      (atau force-close app) persis saat mesin sedang bergerak menuju sensor
      atau sedang probe, sambung/buka lagi. **Harapan**: `job-recovery.json`
      (lihat P9) tetap menunjukkan `resumeLine` = baris M6 itu sendiri (bukan
      baris sebelum/sesudahnya), state `interrupted`/`stopped` sesuai cara
      diputus. Mulai job BARU dengan fixedToolSensor dan M6 pertamanya:
      **harus diperlakukan sebagai baseline lagi** (tanpa G10) — baseline dari
      percobaan yang terputus tadi TIDAK BOLEH nyangkut/kepakai di job baru.
      **Cepat cek**: `npm test` → test-test `INTERRUPTION:` di
      `test/toolsensor-probe-sequence.test.js` (otomatis, cek logikanya; test
      manual ini yang konfirmasi hardware beneran berhenti bersih).
- [ ] **Dua M6 fixedToolSensor berturut-turut dalam satu job**: sudah
      tercakup di skenario "Sequence normal end-to-end" di atas, tapi
      perhatikan khusus baris `G10 L20 P.. Z..` yang muncul di Log saat M6
      kedua — **nilai Z di baris itu harus sama dengan hasil probe tool
      PERTAMA** (baseline), bukan `Z0` dan bukan angka yang tidak masuk akal.
      Kalau punya 3 tool, ulangi untuk M6 ketiga — baseline yang dipakai tetap
      harus dari tool PERTAMA, bukan dari tool kedua.

**Known limitation (v1, disetujui — bukan bug):** hanya perilaku
"always-probe" untuk tool pertama yang aktif. Pilihan "always-wizard" dan
"prompt" di dialog pengaturan tersimpan tapi belum berefek apapun.

---

## Ringkasan: Area Paling Berisiko (prioritaskan waktu review di sini)

1. **🔴 Fixed Tool Sensor (P11)** — SATU-SATUNYA fitur di seluruh app yang
   menggerakkan mesin OTOMATIS, berkali-kali, tanpa konfirmasi per langkah
   (G53 + probe G38.2 + kembali). Kalau dilewati atau ditest asal-asalan,
   risikonya tabrakan fisik (collet/tool ke sensor atau benda kerja) tanpa ada
   kesempatan membatalkan di tengah jalan. **WAJIB test pertama tanpa endmill
   terpasang, tangan siap di E-Stop, sampai terbukti aman berkali-kali.**
2. **🔴 Laser profile homing behavior ($44/$45)** — ini SATU-SATUNYA test di
   seluruh daftar yang bergantung pada ASUMSI (nilai $45 firmware Anda sudah
   berisi mask X+Y), bukan sesuatu yang app jamin. Kalau dilewati, risikonya
   Z bisa ikut/tidak ikut homing dengan cara yang tidak terduga — **test ini di
   UC-100 dengan tangan siap di E-Stop sebelum dipakai kerja beneran.**
3. **🔴 Force-close port di grblHAL USB-CDC** — dari histori P1, USB-CDC lebih
   rawan port nyangkut dibanding chip serial biasa. Kalau cuma test di GRBL dan
   skip grblHAL, bisa lolos padahal grblHAL-nya masih bermasalah.
4. **🟠 Toggle jarak jog di window kecil** — ini murni bug regresi yang PERNAH
   terjadi (overlap dengan tab bar). Kalau hanya ditest di window full-screen,
   bug serupa bisa lolos tanpa ketahuan.
5. **🟠 CORS/CSRF dari device LAN lain** — automated test cuma cek KODE-nya ada,
   bukan bahwa server BENERAN menolak di jaringan asli. Ini satu-satunya test
   security yang perlu 2 perangkat fisik untuk benar-benar diverifikasi.
6. **🟡 TLS/TCZ error-handling** — firmware-dependent (Mythos custom), automated
   test tidak bisa menjangkau ini sama sekali (butuh hardware nyata + firmware
   spesifik Anda) — kalau dilewati, tidak ada jaring pengaman otomatis apapun.

Semua yang TIDAK masuk daftar di atas sudah punya automated test yang jalan tiap
`npm test` — kalau waktu terbatas, boleh percaya ke automated test untuk P0/P3/P4/P5/
struktur-P6 dan fokus waktu manual ke 5 area di atas.

---

## Enumerasi setting grblHAL ($ES)

Tes dengan controller grblHAL yang benar-benar melaporkan `ENUMS` di `[NEWOPT:...]` (jawaban `$I`) dan, kalau
ada, dengan controller Grbl/FluidNC biasa. (Token `ES` di NEWOPT = E-stop, BUKAN enumerasi setting.)

- [ ] **grblHAL + ENUMS**: sambungkan. Di console muncul SATU baris "Read N setting definitions from the
      controller" dan TIDAK ada baris mentah `[SETTING:...]`. Setting yang dulu ";unknown" ($160-$162, $485,
      $539, $676, $680, ...) sekarang punya nama di log `$$`, di file backup, dan di dialog progres simpan.
- [ ] **Tab Advanced Settings**: baris untuk setting di luar template statis menampilkan nama, satuan (mm, ms, ...),
      dan petunjuk (rentang / label bit); tooltip baris berisi keterangan yang sama; "restart the controller after
      saving" muncul untuk setting yang butuh reboot. Ubah satu nilai, Save: tersimpan (`$160=...`) seperti
      setting biasa.
- [ ] **Edit belum disimpan tidak hilang**: ubah satu nilai lalu (sambil menunggu) tekan Refresh - tabel tidak
      dibangun ulang diam-diam saat ada edit yang belum disimpan.
- [ ] **Firmware TANPA ENUMS** (grblHAL lama, Grbl 1.1, FluidNC): `$ES` TIDAK PERNAH dikirim (lihat serial log /
      console: tidak ada `$ES`), tidak ada `error:3`, panel persis seperti sebelumnya (kunci merah + input biasa,
      ";unknown" di log).
- [ ] **Sambung ulang / ganti controller**: putus lalu sambung ke grblHAL yang sama membaca ulang sekali; pindah
      ke firmware lain tidak membawa nama setting dari controller sebelumnya.
- [ ] **Halaman Jog HP** terbuka bersamaan: tidak ada `$ES` ganda (hanya app desktop yang meminta).
