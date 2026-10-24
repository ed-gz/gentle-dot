package dev.gentledot.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Text-only drafts are encrypted locally; neither scope nor text leaves the phone. */
final class MobileDraftStore {
    private static final String ALIAS = "gentledot-mobile-drafts-v1";
    private static DraftLedger instance;
    static String scope(String value) throws Exception {
        if (value == null || value.isEmpty() || value.length() > 4096) throw new IllegalArgumentException("Identidad de borrador no válida.");
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder();
        for (byte item : digest) result.append(String.format(java.util.Locale.ROOT, "%02x", item & 255));
        return result.toString();
    }
    static void validateText(String value) {
        if (value == null || value.getBytes(StandardCharsets.UTF_8).length > 64 * 1024)
            throw new IllegalArgumentException("El borrador supera el límite local de 64 KiB.");
    }
    private static SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        if (!create) throw new IllegalStateException("No se pudo abrir el almacenamiento de borradores.");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    static synchronized DraftLedger ledger(Context context) {
        if (instance != null) return instance;
        SharedPreferences prefs = context.getApplicationContext().getSharedPreferences("gentledot-drafts-v1", Context.MODE_PRIVATE);
        instance = new DraftLedger(new DraftLedger.Storage() {
            @Override public DraftLedger.Record read(String scope) throws Exception {
                String stored = prefs.getString(scope, null);
                if (stored == null) return new DraftLedger.Record("", "0");
                JSONObject envelope = new JSONObject(stored);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)));
                cipher.updateAAD(scope.getBytes(StandardCharsets.UTF_8));
                JSONObject value = new JSONObject(new String(cipher.doFinal(Base64.decode(envelope.getString("data"), Base64.NO_WRAP)), StandardCharsets.UTF_8));
                return new DraftLedger.Record(value.getString("text"), value.getString("revision"));
            }
            @Override public void write(String scope, DraftLedger.Record record) throws Exception {
                JSONObject value = new JSONObject(); value.put("text", record.text); value.put("revision", record.revision);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key(true));
                cipher.updateAAD(scope.getBytes(StandardCharsets.UTF_8));
                JSONObject envelope = new JSONObject(); envelope.put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP));
                envelope.put("data", Base64.encodeToString(cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
                if (!prefs.edit().putString(scope, envelope.toString()).commit()) throw new IllegalStateException("No se pudo guardar el borrador.");
            }
        });
        return instance;
    }
}
