mod crypto;
mod license;
mod master;
mod net;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            crypto::sv_keygen,
            crypto::sv_encrypt,
            crypto::sv_decrypt,
            net::sv_health,
            net::sv_submit,
            net::sv_list,
            net::sv_open,
            master::sv_get_server,
            master::sv_license_status,
            master::sv_prepare_master,
            master::sv_check_server,
            master::sv_finish_master,
            master::sv_login,
            master::sv_renew_license,
            master::sv_create_profile,
            master::sv_list_profiles,
            master::sv_change_password,
            master::sv_save_roles,
            master::sv_reset_profile_password,
            master::sv_set_profile_revoked,
            master::sv_add_org,
            master::sv_save_me,
            master::sv_log,
            master::sv_rename_org,
            master::sv_dir_submit,
            master::sv_dir_list,
            master::sv_dir_open,
            master::sv_dir_open_file,
            master::sv_dir_delete,
            master::sv_dir_folders,
            master::sv_dir_mkfolder,
            master::sv_cat_list,
            master::sv_cat_make,
            master::sv_save_file,
            master::sv_rv_profiles,
            master::sv_rv_list,
            master::sv_rv_recent,
            master::sv_rv_open,
            master::sv_rv_open_file,
            master::sv_rv_submit,
            master::sv_rv_delete,
            master::sv_cm_list,
            master::sv_cm_add,
            master::sv_connect_code,
            master::sv_conn_status,
            master::sv_make_conn_code,
            license::sv_check_license,
            net::sv_auth_methods
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
