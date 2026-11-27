# UC CONTROL 2.0.1 — Patch Stabilitas

Rilis ini fokus pada keandalan saat mengirim job ke mesin. Tidak ada fitur baru; perubahan cara aplikasi
dibuka dan ditutup ada di bagian "Perilaku aplikasi".
Sudah diuji di board UC-100 (GRBL Mythos 4A-AS).

## Job berhenti dengan benar

- **Restart / Restart Grbl** kini me-reset controller seketika, termasuk di tengah job. Sebelumnya reset baru
  terjadi setelah sisa job terkirim.
- **Stop, Restart, error, dan ALARM** sekarang benar-benar mengakhiri job. Sisa baris yang belum terkirim
  dibatalkan, dan log menyebut jumlahnya, misalnya `38 baris belum terkirim dibatalkan karena Restart`.
  Sebelumnya sisa job bisa jalan lagi setelah perintah berikutnya, misalnya setelah `$X`.
- Saat **ALARM**, hanya perintah `$` (`$X`, `$H`, `$$`, ...) yang diterima. Gerakan ditolak dengan pesan
  `Mesin ALARM — kirim $X/$H dulu`.
- **Clear Alarm** mengirim `$X` setelah controller siap, dan jawabannya tercatat dengan benar.
- Jawaban di log selalu berlabel perintahnya sendiri. Pesan spontan dari controller (banner, `ALARM:`,
  `[MSG:...]`) tampil tanpa label.

## Deteksi USB putus

- USB yang tercabut terdeteksi; koneksi yang tidak menjawab selama 3 detik (kecuali saat homing) juga
  dianggap putus. Job dihentikan dan bisa dilanjutkan lewat notifikasi 'Pekerjaan belum selesai'.
- Homing yang lama (controller memang diam selama homing) dan E-stop yang ditahan **tidak** dianggap putus.
- Job tidak pernah dilanjutkan otomatis setelah koneksi kembali.

## Konsol lebih jelas

- Setiap perintah yang tidak dikirim selalu disertai alasan di log, misalnya port terputus, controller
  belum siap, mesin ALARM, atau job sedang pause.
- Saat job berjalan atau pause, kotak konsol berwarna abu-abu dengan keterangan apa yang harus dilakukan.
  Tombol Send ikut nonaktif.
- Tombol Esc (Abort) menulis `Reset (Esc)` di log.
- Label **Homing** dan **Hard Limit** langsung ikut berubah saat `$22` / `$21` diubah dari konsol.

## Perilaku aplikasi

- UC CONTROL **tidak lagi berjalan otomatis** saat Windows login. Entri auto-start dari versi lama dihapus
  saat update.
- **Tidak ada mode tray/latar belakang.** Menutup jendela berarti aplikasi keluar total dan koneksi ke mesin
  ditutup. Bila job sedang berjalan, aplikasi bertanya dulu.
- Membuka ikon UC CONTROL saat aplikasi sudah terbuka akan memunculkan jendela yang ada, bukan membuka
  jendela kedua.
- Data aplikasi kini disimpan di folder `%APPDATA%\UrbanCreatorCONTROL`. Macro, backup setting, shortcut,
  dan data job yang belum selesai dari versi lama **disalin otomatis** saat 2.0.1 pertama kali dibuka.
  Folder lama tidak diubah.

## Perbaikan kecil

- Tombol di title bar tetap bisa diklik saat ada dialog terbuka.
- Tombol tutup (x) pada notifikasi "Pekerjaan belum selesai" bisa diklik di seluruh area pojoknya.
- Setting GRBL Mythos `$309`, `$319`, `$329` tampil dengan nama dan keterangan.
