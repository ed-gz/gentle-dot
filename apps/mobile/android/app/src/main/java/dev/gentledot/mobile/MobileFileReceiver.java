package dev.gentledot.mobile;

import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.Closeable;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.Comparator;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/** One explicit user transfer at a time. No credentials are written to disk. */
final class MobileFileReceiver {
    private static final long CACHE_TTL_MS = TimeUnit.HOURS.toMillis(24);
    private static final long CACHE_BUDGET = 4 * FileTransferBoundary.MAX_BYTES;
    private final GentleMobilePlugin plugin;
    private final Context context;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicReference<Transfer> active = new AtomicReference<>();
    private final OkHttpClient http = new OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(3, TimeUnit.MINUTES).build();
    private volatile boolean closed;

    MobileFileReceiver(GentleMobilePlugin plugin) {
        this.plugin = plugin;
        this.context = plugin.getContext().getApplicationContext();
        worker.execute(() -> cleanupCache(0));
    }

    boolean busy() { return active.get() != null; }

    void receive(PluginCall call) {
        String url = call.getString("url", "");
        String token = call.getString("token", "");
        String name = call.getString("name", "");
        String mime = call.getString("mime", "");
        String action = call.getString("action", "");
        // Activity state restoration must never persist the authorization token.
        call.getData().remove("token");
        call.getData().remove("url");
        try { FileTransferBoundary.validate(url, token, name, mime, action); }
        catch (IllegalArgumentException error) { call.reject(error.getMessage(), "FILE_INVALID"); return; }
        if (closed) { call.reject("Transferencia cancelada.", "FILE_CANCELLED"); return; }
        Transfer transfer = new Transfer(call, name, mime, action);
        if (!active.compareAndSet(null, transfer)) {
            call.reject("Termina o cancela la transferencia actual.", "FILE_BUSY"); return;
        }
        execute(transfer, () -> download(transfer, url, token));
    }

    void cancel() {
        Transfer transfer = active.get();
        if (transfer == null) return;
        transfer.cancelled.set(true);
        Call network = transfer.network;
        if (network != null) network.cancel();
        transfer.signal.cancel();
        closeQuietly(transfer.stream);
        if (transfer.choosing) finish(transfer, "cancelled", null, null);
    }

    void destroy() {
        closed = true;
        cancel();
        worker.shutdownNow();
        http.connectionPool().evictAll();
    }

    private void execute(Transfer transfer, Runnable action) {
        try { worker.execute(action); }
        catch (RejectedExecutionException error) { finish(transfer, "cancelled", null, null); }
    }

    private void download(Transfer transfer, String url, String token) {
        try {
            if (transfer.cancelled.get()) throw new FileTransferBoundary.Cancelled();
            cleanupCache(FileTransferBoundary.MAX_BYTES);
            File folder = new File(cacheDirectory(), UUID.randomUUID().toString());
            if (!folder.mkdirs()) throw new IOException("No se pudo preparar el archivo.");
            transfer.folder = folder;
            transfer.file = new File(folder, transfer.name);
            Request request = new Request.Builder().url(url)
                .header("Authorization", "Bearer " + token).header("Accept-Encoding", "identity").get().build();
            Call network = http.newCall(request);
            transfer.network = network;
            if (transfer.cancelled.get()) network.cancel();
            try (Response response = network.execute()) {
                if (response.code() != 200) throw new IOException("El equipo no pudo entregar el archivo.");
                if (response.headers("Content-Length").size() > 1) throw new IOException("Longitud ambigua.");
                long length = FileTransferBoundary.declaredLength(response.header("Content-Length"));
                String encoding = response.header("Content-Encoding", "identity");
                if (!"identity".equalsIgnoreCase(encoding)) throw new IOException("Formato de transferencia no admitido.");
                ResponseBody body = response.body();
                if (body == null) throw new IOException("No se recibió el archivo.");
                try (InputStream input = body.byteStream(); OutputStream output = new FileOutputStream(transfer.file)) {
                    transfer.stream = input;
                    FileTransferBoundary.copy(input, output, length, transfer.cancelled::get);
                } finally { transfer.stream = null; }
            } finally { transfer.network = null; }
            if (transfer.cancelled.get()) throw new FileTransferBoundary.Cancelled();
            plugin.getActivity().runOnUiThread(() -> present(transfer));
        } catch (Exception error) { fail(transfer, error, false); }
    }

    private void present(Transfer transfer) {
        if (transfer.finished.get()) return;
        if (closed || transfer.cancelled.get()) { finish(transfer, "cancelled", null, null); return; }
        try {
            if ("save".equals(transfer.action)) {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE).setType(transfer.mime)
                    .putExtra(Intent.EXTRA_TITLE, transfer.name);
                transfer.choosing = true;
                plugin.startActivityForResult(transfer.call, intent, "receivedFileDestination");
            } else {
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", transfer.file);
                Intent share = new Intent(Intent.ACTION_SEND).setType(transfer.mime)
                    .putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_TITLE, transfer.name)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                share.setClipData(ClipData.newUri(context.getContentResolver(), transfer.name, uri));
                plugin.getActivity().startActivity(Intent.createChooser(share, "Compartir archivo")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
                // Android does not report whether the recipient actually sent the file.
                finish(transfer, "shared", null, null);
            }
        } catch (Exception error) {
            finish(transfer, null, "FILE_UNAVAILABLE", "Android no pudo abrir el selector de archivos.");
        }
    }

    void destination(PluginCall call, ActivityResult result) {
        Transfer transfer = active.get();
        if (transfer == null || call == null || !transfer.call.getCallbackId().equals(call.getCallbackId())) return;
        transfer.choosing = false;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || transfer.cancelled.get()) {
            finish(transfer, "cancelled", null, null); return;
        }
        Uri uri = result.getData().getData();
        if (uri == null || !"content".equals(uri.getScheme()) || !DocumentsContract.isDocumentUri(context, uri)) {
            finish(transfer, null, "FILE_SAVE", "Android no devolvió una ubicación válida."); return;
        }
        execute(transfer, () -> save(transfer, uri));
    }

    private void save(Transfer transfer, Uri destination) {
        try {
            if (transfer.cancelled.get()) throw new FileTransferBoundary.Cancelled();
            ParcelFileDescriptor descriptor = context.getContentResolver().openFileDescriptor(destination, "wt", transfer.signal);
            if (descriptor == null) throw new IOException("No se pudo abrir la ubicación elegida.");
            try (ParcelFileDescriptor owned = descriptor;
                 InputStream input = new FileInputStream(transfer.file);
                 OutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(descriptor)) {
                transfer.stream = output;
                FileTransferBoundary.copy(input, output, transfer.file.length(), transfer.cancelled::get);
                output.flush();
            } finally { transfer.stream = null; }
            if (transfer.cancelled.get()) throw new FileTransferBoundary.Cancelled();
            finish(transfer, "saved", null, null);
        } catch (Exception error) {
            // ACTION_CREATE_DOCUMENT creates a new document, so remove only this failed result.
            try { DocumentsContract.deleteDocument(context.getContentResolver(), destination); }
            catch (Exception ignored) { /* Some document providers do not support deletion. */ }
            fail(transfer, error, true);
        }
    }

    private void fail(Transfer transfer, Exception error, boolean saving) {
        if (transfer.cancelled.get() || error instanceof FileTransferBoundary.Cancelled) {
            finish(transfer, "cancelled", null, null);
        } else if (error instanceof FileTransferBoundary.TooLarge) {
            finish(transfer, null, "FILE_TOO_LARGE", "El archivo supera el límite de 50 MiB.");
        } else if (error instanceof InterruptedIOException) {
            finish(transfer, null, "FILE_TIMEOUT", "La descarga tardó demasiado. Comprueba Tailscale y vuelve a intentarlo.");
        } else {
            finish(transfer, null, saving ? "FILE_SAVE" : "FILE_DOWNLOAD", saving
                ? "No se pudo guardar el archivo en la ubicación elegida."
                : "No se pudo descargar el archivo. Comprueba la conexión o vuelve a solicitarlo al equipo.");
        }
    }

    private void finish(Transfer transfer, String status, String code, String message) {
        if (!transfer.finished.compareAndSet(false, true)) return;
        active.compareAndSet(transfer, null);
        if (!"shared".equals(status)) removeFolder(transfer.folder);
        if (code != null) transfer.call.reject(message, code);
        else {
            JSObject response = new JSObject();
            response.put("status", status);
            transfer.call.resolve(response);
        }
    }

    private File cacheDirectory() { return new File(context.getCacheDir(), "received-files"); }

    private void cleanupCache(long reserve) {
        File[] folders = cacheDirectory().listFiles();
        if (folders == null) return;
        Arrays.sort(folders, Comparator.comparingLong(File::lastModified));
        long total = 0;
        long cutoff = System.currentTimeMillis() - CACHE_TTL_MS;
        for (File folder : folders) {
            if (folder.lastModified() < cutoff) removeFolder(folder);
            else total += folderSize(folder);
        }
        for (File folder : folders) {
            if (total + reserve <= CACHE_BUDGET) break;
            long size = folderSize(folder);
            removeFolder(folder);
            total -= size;
        }
    }

    private long folderSize(File folder) {
        File[] files = folder.listFiles();
        if (files == null) return 0;
        long size = 0;
        for (File file : files) size += file.length();
        return size;
    }

    private void removeFolder(File folder) {
        if (folder == null) return;
        File[] files = folder.listFiles();
        if (files != null) for (File file : files) {
            try {
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
                context.revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) { /* Deletion also makes stale grants unusable. */ }
            file.delete();
        }
        folder.delete();
    }

    private static void closeQuietly(Closeable stream) {
        if (stream != null) try { stream.close(); } catch (IOException ignored) { }
    }

    private static final class Transfer {
        final PluginCall call;
        final String name, mime, action;
        final AtomicBoolean cancelled = new AtomicBoolean();
        final AtomicBoolean finished = new AtomicBoolean();
        final CancellationSignal signal = new CancellationSignal();
        volatile Call network;
        volatile Closeable stream;
        volatile boolean choosing;
        File folder, file;
        Transfer(PluginCall call, String name, String mime, String action) {
            this.call = call; this.name = name; this.mime = mime; this.action = action;
        }
    }
}
