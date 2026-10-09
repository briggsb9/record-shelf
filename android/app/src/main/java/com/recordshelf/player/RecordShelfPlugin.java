package com.recordshelf.player;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "RecordShelf")
public class RecordShelfPlugin extends Plugin {
    private static final String PREFS = "record_shelf";
    private static final String ROOT_KEY = "library_root";
    private static final Set<String> AUDIO_EXTENSIONS = new HashSet<>();

    static {
        Collections.addAll(AUDIO_EXTENSIONS, "aac", "aif", "aiff", "alac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma");
    }

    private final ExecutorService scanner = Executors.newSingleThreadExecutor();

    private static final class AudioDocument {
        final Uri uri;
        final String name;

        AudioDocument(Uri uri, String name) {
            this.uri = uri;
            this.name = name;
        }
    }

    @Override
    protected void handleOnDestroy() {
        scanner.shutdownNow();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void getLibrary(PluginCall call) {
        try {
            call.resolve(envelope(loadLibrary()));
        } catch (Exception error) {
            call.reject("The saved catalogue could not be read.", error);
        }
    }

    @PluginMethod
    public void chooseFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "folderChosen");
    }

    @ActivityCallback
    private void folderChosen(PluginCall call, ActivityResult result) {
        JSObject response = new JSObject();
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            response.put("root", JSONObject.NULL);
            call.resolve(response);
            return;
        }

        Uri root = data.getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(root, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
            // Some providers grant access for the app lifetime but do not support persistence.
        }
        preferences().edit().putString(ROOT_KEY, root.toString()).apply();
        response.put("root", root.toString());
        call.resolve(response);
    }

    @PluginMethod
    public void scanFolder(PluginCall call) {
        String requestedRoot = call.getString("root", "");
        String rootValue = requestedRoot.isEmpty() ? preferences().getString(ROOT_KEY, "") : requestedRoot;
        if (rootValue == null || rootValue.isEmpty()) {
            call.reject("Choose a music folder first.");
            return;
        }

        scanner.execute(() -> {
            try {
                Uri root = Uri.parse(rootValue);
                notifyScan("discovering", 0, 0, null);
                List<AudioDocument> documents = new ArrayList<>();
                collectAudioDocuments(root, DocumentsContract.getTreeDocumentId(root), documents);

                JSONObject previous = loadLibrary();
                JSONArray previousAlbums = previous.optJSONArray("albums");
                if (documents.isEmpty() && previousAlbums != null && previousAlbums.length() > 0) {
                    throw new IllegalStateException("No audio files were visible. The saved catalogue was retained in case the folder or NAS is temporarily unavailable.");
                }

                JSONObject library = buildLibrary(rootValue, documents, previous.optJSONArray("playlists"));
                saveLibrary(library);
                preferences().edit().putString(ROOT_KEY, rootValue).apply();
                call.resolve(envelope(library));
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "The music folder could not be scanned." : error.getMessage(), error);
            }
        });
    }

    @PluginMethod
    public void getTrackUrl(PluginCall call) {
        Integer trackId = call.getInt("trackId");
        if (trackId == null) {
            call.reject("A track id is required.");
            return;
        }
        try {
            JSONObject track = findTrack(loadLibrary(), trackId);
            if (track == null) {
                call.reject("Track not found.");
                return;
            }
            JSObject response = new JSObject();
            response.put("url", track.getString("path"));
            call.resolve(response);
        } catch (Exception error) {
            call.reject("The track could not be opened.", error);
        }
    }

    @PluginMethod
    public void createPlaylist(PluginCall call) {
        try {
            JSONObject library = loadLibrary();
            JSONArray playlists = ensureArray(library, "playlists");
            JSONObject playlist = new JSONObject();
            playlist.put("id", UUID.randomUUID().toString());
            String cleanName = call.getString("name", "").trim();
            playlist.put("name", cleanName.isEmpty() ? "Untitled Playlist" : cleanName);
            playlist.put("trackIds", new JSONArray());
            playlists.put(playlist);
            saveLibrary(library);
            call.resolve(envelope(playlist));
        } catch (Exception error) {
            call.reject("The playlist could not be created.", error);
        }
    }

    @PluginMethod
    public void deletePlaylist(PluginCall call) {
        mutatePlaylists(call, (playlists, playlistId, trackId) -> {
            for (int index = playlists.length() - 1; index >= 0; index--) {
                if (playlistId.equals(playlists.getJSONObject(index).optString("id"))) playlists.remove(index);
            }
        });
    }

    @PluginMethod
    public void addToPlaylist(PluginCall call) {
        mutatePlaylists(call, (playlists, playlistId, trackId) -> {
            if (trackId == null) throw new JSONException("A track id is required.");
            JSONObject playlist = findPlaylist(playlists, playlistId);
            if (playlist == null) throw new JSONException("Playlist not found.");
            JSONArray ids = ensureArray(playlist, "trackIds");
            for (int index = 0; index < ids.length(); index++) if (ids.optInt(index, -1) == trackId) return;
            ids.put(trackId);
        });
    }

    @PluginMethod
    public void removeFromPlaylist(PluginCall call) {
        mutatePlaylists(call, (playlists, playlistId, trackId) -> {
            if (trackId == null) throw new JSONException("A track id is required.");
            JSONObject playlist = findPlaylist(playlists, playlistId);
            if (playlist == null) throw new JSONException("Playlist not found.");
            JSONArray ids = ensureArray(playlist, "trackIds");
            for (int index = ids.length() - 1; index >= 0; index--) if (ids.optInt(index, -1) == trackId) ids.remove(index);
        });
    }

    @PluginMethod
    public void fetchAlbumArtwork(PluginCall call) {
        try {
            JSONObject library = loadLibrary();
            JSObject result = new JSObject();
            result.put("success", false);
            result.put("message", "This Android preview retains embedded artwork. Online artwork lookup is not available yet.");
            result.put("albumId", call.getString("albumId", ""));
            JSObject response = new JSObject();
            response.put("result", result);
            response.put("library", library);
            call.resolve(response);
        } catch (Exception error) {
            call.reject("Artwork status could not be read.", error);
        }
    }

    @PluginMethod
    public void fetchMissingArtwork(PluginCall call) {
        try {
            JSONObject library = loadLibrary();
            int missing = 0;
            JSONArray albums = library.optJSONArray("albums");
            if (albums != null) {
                for (int index = 0; index < albums.length(); index++) {
                    if (albums.getJSONObject(index).isNull("artworkUrl")) missing++;
                }
            }
            JSObject result = new JSObject();
            result.put("found", 0);
            result.put("missing", missing);
            JSObject response = new JSObject();
            response.put("result", result);
            response.put("library", library);
            call.resolve(response);
        } catch (Exception error) {
            call.reject("Artwork status could not be read.", error);
        }
    }

    @PluginMethod
    public void fetchArtistArtwork(PluginCall call) {
        try {
            JSONObject library = loadLibrary();
            JSObject result = new JSObject();
            result.put("success", false);
            result.put("message", "Android currently uses album artwork as the artist image fallback.");
            result.put("albumId", call.getString("artist", ""));
            JSObject response = new JSObject();
            response.put("result", result);
            response.put("library", library);
            call.resolve(response);
        } catch (Exception error) {
            call.reject("Artist artwork status could not be read.", error);
        }
    }

    @PluginMethod
    public void fetchMissingArtistArtwork(PluginCall call) {
        try {
            JSONObject library = loadLibrary();
            Set<String> names = new HashSet<>();
            JSONArray albums = library.optJSONArray("albums");
            if (albums != null) {
                for (int index = 0; index < albums.length(); index++) names.add(albums.getJSONObject(index).optString("artist"));
            }
            JSObject result = new JSObject();
            result.put("found", 0);
            result.put("missing", names.size());
            JSObject response = new JSObject();
            response.put("result", result);
            response.put("library", library);
            call.resolve(response);
        } catch (Exception error) {
            call.reject("Artist artwork status could not be read.", error);
        }
    }

    private JSONObject buildLibrary(String root, List<AudioDocument> documents, JSONArray savedPlaylists) throws Exception {
        Map<String, JSONObject> albums = new HashMap<>();
        Map<String, List<JSONObject>> tracksByAlbum = new HashMap<>();
        File artworkDirectory = new File(getContext().getFilesDir(), "artwork");
        if (!artworkDirectory.exists() && !artworkDirectory.mkdirs()) throw new IllegalStateException("Artwork storage could not be created.");

        for (int index = 0; index < documents.size(); index++) {
            AudioDocument document = documents.get(index);
            notifyScan("reading", index + 1, documents.size(), document.name);
            MediaMetadataRetriever retriever = new MediaMetadataRetriever();
            try {
                retriever.setDataSource(getContext(), document.uri);
                String title = firstNonBlank(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE), stripExtension(document.name));
                String artist = firstNonBlank(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST), "Unknown Artist");
                String albumTitle = firstNonBlank(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM), "Unknown Album");
                String albumArtist = firstNonBlank(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST), artist);
                String albumId = "android-" + sha1(albumArtist.toLowerCase(Locale.ROOT) + "\u0000" + albumTitle.toLowerCase(Locale.ROOT));
                int trackId = stableTrackId(document.uri.toString());
                int year = parseLeadingInt(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_YEAR));

                JSONObject track = new JSONObject();
                track.put("id", trackId);
                track.put("albumId", albumId);
                track.put("path", document.uri.toString());
                track.put("title", title);
                track.put("artist", artist);
                track.put("album", albumTitle);
                track.put("albumArtist", albumArtist);
                track.put("trackNumber", parseLeadingInt(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER)));
                track.put("discNumber", parseLeadingInt(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DISC_NUMBER)));
                track.put("duration", parseLong(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)) / 1000.0);
                track.put("year", year == 0 ? JSONObject.NULL : year);

                List<JSONObject> albumTracks = tracksByAlbum.computeIfAbsent(albumId, ignored -> new ArrayList<>());
                albumTracks.add(track);
                if (!albums.containsKey(albumId)) {
                    JSONObject album = new JSONObject();
                    album.put("id", albumId);
                    album.put("title", albumTitle);
                    album.put("artist", albumArtist);
                    album.put("year", year == 0 ? JSONObject.NULL : year);
                    String artwork = cacheEmbeddedArtwork(albumId, retriever.getEmbeddedPicture(), artworkDirectory);
                    album.put("artworkUrl", artwork == null ? JSONObject.NULL : artwork);
                    album.put("artworkSource", artwork == null ? JSONObject.NULL : "embedded");
                    albums.put(albumId, album);
                }
            } catch (Exception ignored) {
                // A damaged or unsupported audio file should not abort the rest of a large NAS scan.
            } finally {
                retriever.release();
            }
        }

        List<JSONObject> sortedAlbums = new ArrayList<>(albums.values());
        sortedAlbums.sort(Comparator.comparing((JSONObject value) -> value.optString("artist").toLowerCase(Locale.ROOT))
            .thenComparing(value -> value.optString("title").toLowerCase(Locale.ROOT)));
        JSONArray albumArray = new JSONArray();
        for (JSONObject album : sortedAlbums) {
            List<JSONObject> tracks = tracksByAlbum.get(album.optString("id"));
            tracks.sort(Comparator.comparingInt((JSONObject value) -> value.optInt("discNumber"))
                .thenComparingInt(value -> value.optInt("trackNumber"))
                .thenComparing(value -> value.optString("title").toLowerCase(Locale.ROOT)));
            JSONArray trackArray = new JSONArray();
            for (JSONObject track : tracks) trackArray.put(track);
            album.put("tracks", trackArray);
            albumArray.put(album);
        }

        notifyScan("finishing", documents.size(), documents.size(), null);
        JSONObject library = new JSONObject();
        library.put("root", root);
        library.put("albums", albumArray);
        library.put("playlists", savedPlaylists == null ? new JSONArray() : savedPlaylists);
        return library;
    }

    private void collectAudioDocuments(Uri treeUri, String parentDocumentId, List<AudioDocument> result) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocumentId);
        String[] projection = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE };
        try (Cursor cursor = resolver.query(children, projection, null, null, null)) {
            if (cursor == null) return;
            while (cursor.moveToNext()) {
                String id = cursor.getString(0);
                String name = cursor.getString(1);
                String mime = cursor.getString(2);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    collectAudioDocuments(treeUri, id, result);
                } else if ((mime != null && mime.startsWith("audio/")) || AUDIO_EXTENSIONS.contains(extension(name))) {
                    result.add(new AudioDocument(DocumentsContract.buildDocumentUriUsingTree(treeUri, id), name == null ? "Audio track" : name));
                }
            }
        }
    }

    private String cacheEmbeddedArtwork(String albumId, byte[] bytes, File directory) throws Exception {
        File jpg = new File(directory, albumId + ".jpg");
        File png = new File(directory, albumId + ".png");
        File existing = jpg.exists() ? jpg : (png.exists() ? png : null);
        if (existing != null) return Uri.fromFile(existing).toString();
        if (bytes == null || bytes.length == 0) return null;
        boolean isPng = bytes.length > 8 && bytes[0] == (byte) 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4e && bytes[3] == 0x47;
        File target = new File(directory, albumId + (isPng ? ".png" : ".jpg"));
        try (FileOutputStream output = new FileOutputStream(target)) {
            output.write(bytes);
        }
        return Uri.fromFile(target).toString();
    }

    private interface PlaylistMutation {
        void run(JSONArray playlists, String playlistId, Integer trackId) throws Exception;
    }

    private void mutatePlaylists(PluginCall call, PlaylistMutation mutation) {
        try {
            String playlistId = call.getString("playlistId", "");
            JSONObject library = loadLibrary();
            mutation.run(ensureArray(library, "playlists"), playlistId, call.getInt("trackId"));
            saveLibrary(library);
            call.resolve(envelope(library));
        } catch (Exception error) {
            call.reject(error.getMessage() == null ? "The playlist could not be changed." : error.getMessage(), error);
        }
    }

    private JSONObject findPlaylist(JSONArray playlists, String id) throws JSONException {
        for (int index = 0; index < playlists.length(); index++) {
            JSONObject playlist = playlists.getJSONObject(index);
            if (id.equals(playlist.optString("id"))) return playlist;
        }
        return null;
    }

    private JSONObject findTrack(JSONObject library, int id) throws JSONException {
        JSONArray albums = library.optJSONArray("albums");
        if (albums == null) return null;
        for (int albumIndex = 0; albumIndex < albums.length(); albumIndex++) {
            JSONArray tracks = albums.getJSONObject(albumIndex).optJSONArray("tracks");
            if (tracks == null) continue;
            for (int trackIndex = 0; trackIndex < tracks.length(); trackIndex++) {
                JSONObject track = tracks.getJSONObject(trackIndex);
                if (track.optInt("id", -1) == id) return track;
            }
        }
        return null;
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFS, Activity.MODE_PRIVATE);
    }

    private File libraryFile() {
        return new File(getContext().getFilesDir(), "library.json");
    }

    private synchronized JSONObject loadLibrary() throws Exception {
        File file = libraryFile();
        if (!file.exists()) {
            JSONObject empty = new JSONObject();
            String root = preferences().getString(ROOT_KEY, null);
            empty.put("root", root == null ? JSONObject.NULL : root);
            empty.put("albums", new JSONArray());
            empty.put("playlists", new JSONArray());
            return empty;
        }
        try (FileInputStream input = new FileInputStream(file); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
        }
    }

    private synchronized void saveLibrary(JSONObject library) throws Exception {
        File target = libraryFile();
        File temporary = new File(target.getParentFile(), target.getName() + ".tmp");
        try (FileOutputStream output = new FileOutputStream(temporary)) {
            output.write(library.toString().getBytes(StandardCharsets.UTF_8));
            output.getFD().sync();
        }
        if (target.exists() && !target.delete()) throw new IllegalStateException("The previous catalogue could not be replaced.");
        if (!temporary.renameTo(target)) throw new IllegalStateException("The catalogue could not be saved.");
    }

    private JSObject envelope(JSONObject value) {
        JSObject response = new JSObject();
        response.put("value", value);
        return response;
    }

    private JSONArray ensureArray(JSONObject object, String key) throws JSONException {
        JSONArray value = object.optJSONArray(key);
        if (value == null) {
            value = new JSONArray();
            object.put(key, value);
        }
        return value;
    }

    private void notifyScan(String phase, int current, int total, String file) {
        JSObject progress = new JSObject();
        progress.put("phase", phase);
        progress.put("current", current);
        progress.put("total", total);
        if (file != null) progress.put("file", file);
        notifyListeners("scanProgress", progress);
    }

    private String firstNonBlank(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }

    private String extension(String name) {
        if (name == null) return "";
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private String stripExtension(String name) {
        if (name == null) return "Untitled Track";
        int dot = name.lastIndexOf('.');
        return dot <= 0 ? name : name.substring(0, dot);
    }

    private int parseLeadingInt(String value) {
        if (value == null) return 0;
        String[] parts = value.trim().split("[/\\s-]", 2);
        try { return Integer.parseInt(parts[0]); } catch (Exception ignored) { return 0; }
    }

    private long parseLong(String value) {
        try { return value == null ? 0 : Long.parseLong(value); } catch (Exception ignored) { return 0; }
    }

    private int stableTrackId(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        return ((digest[0] & 0x7f) << 24) | ((digest[1] & 0xff) << 16) | ((digest[2] & 0xff) << 8) | (digest[3] & 0xff);
    }

    private String sha1(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-1").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder();
        for (byte item : digest) result.append(String.format(Locale.ROOT, "%02x", item));
        return result.toString();
    }
}
