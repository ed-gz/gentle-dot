package dev.gentledot.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Only an explicit notification opt-in persists credentials, encrypted by Android Keystore. */
final class MonitorCredentials {
    private static final String ALIAS = "gentledot-notification-monitor-v1";
    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences("gentledot-monitor", Context.MODE_PRIVATE);
    }
    private static SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        if (!create) throw new IllegalStateException("Monitor key unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    static void save(Context context, String origin, String token) throws Exception {
        JSONObject value = new JSONObject(); value.put("url", origin); value.put("token", token);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        byte[] encrypted = cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
        if (!preferences(context).edit().putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString("credentials", Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit())
            throw new IllegalStateException("Could not save monitor settings");
    }
    static JSONObject load(Context context) {
        try {
            SharedPreferences prefs = preferences(context);
            String encrypted = prefs.getString("credentials", null), iv = prefs.getString("iv", null);
            if (encrypted == null || iv == null) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            return new JSONObject(new String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), StandardCharsets.UTF_8));
        } catch (Exception error) { clear(context); return null; }
    }
    static void clear(Context context) { preferences(context).edit().clear().commit(); }
}
