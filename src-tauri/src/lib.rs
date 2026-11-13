// PEEL masaüstü sürümü (H175): web uygulamasının aynısı, sistem web görünümünde ve tamamen çevrimdışı.
// Rust tarafı hiçbir komut açmaz (invoke yüzeyi boş); dosya açma/kaydetme web uygulamasının kendi
// <input type="file"> ve indirme akışlarıyla yapılır. Ağ izni yoktur: CSP yalnızca uygulamanın kendi kaynaklarına izin verir.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("PEEL başlatılamadı");
}
