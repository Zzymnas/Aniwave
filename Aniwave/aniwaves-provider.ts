/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />

/**
 * Seanime Online Streaming Provider for aniwaves.ru (v3.0.0)
 *
 * Fully fetch-based — NO ChromeDP dependency.
 *
 * Endpoints used:
 *   AJAX Search:    GET /ajax/anime/search?keyword={query}
 *   Watch page:     GET /watch/{slug}  (JSON-LD for episode count)
 *   AJAX Servers:   GET /ajax/server/list?servers={animeId}&eps={epNum}
 *   AJAX Sources:   GET /ajax/sources?id={data-link-id}&asi=0&autoPlay=0
 *     Returns JSON: {status: 200, result: {url: "https://myvidplay.com/e/{id}"}}
 *   DoodStream:     GET {embedUrl} → parse pass_md5 → GET /pass_md5/{hash}/{token}
 *     Returns CDN base URL → append random token → final mp4 video URL
 */

class Provider {
    baseUrl = "https://aniwaves.ru"

    getSettings(): Settings {
        return {
            episodeServers: ["DGHG"],
            supportsDub: true,
        }
    }

    // ─── Search ─────────────────────────────────────────────────────────
    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const query = opts.query || opts.media.englishTitle || opts.media.romajiTitle || ""
        if (!query) return []

        const url = this.baseUrl + "/ajax/anime/search?keyword=" + encodeURIComponent(query)
        const res = await fetch(url)
        if (!res.ok) return []

        var data: any
        try {
            data = res.json()
        } catch (e) {
            return []
        }

        if (!data || !data.result || !data.result.html) return []

        var $ = LoadDoc(data.result.html)
        var results: SearchResult[] = []

        $("a.item").each(function (_: number, el: DocSelection) {
            var href = el.attr("href") || ""
            var nameEl = el.find(".name.d-title")
            var title = nameEl.text().trim()

            if (!title || !href) return

            var slug = href.replace(/^\/watch\//, "")
            if (!slug) return

            results.push({
                id: slug,
                title: title,
                url: "https://aniwaves.ru/watch/" + slug,
                subOrDub: "sub" as SubOrDub,
            })
        })

        return results
    }

    // ─── Find Episodes ──────────────────────────────────────────────────
    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        var watchUrl = this.baseUrl + "/watch/" + id
        var res = await fetch(watchUrl)
        if (!res.ok) return []

        var html = res.text()
        var episodes: EpisodeDetails[] = []

        // Extract episode count from JSON-LD
        var subMatch = html.match(/"Subbed episodes released"[^}]*"value"\s*:\s*(\d+)/)
        var dubMatch = html.match(/"Dubbed episodes released"[^}]*"value"\s*:\s*(\d+)/)

        var epCount = 0
        if (subMatch) {
            epCount = parseInt(subMatch[1], 10)
        }
        if (dubMatch) {
            var dubCount = parseInt(dubMatch[1], 10)
            if (dubCount > epCount) {
                epCount = dubCount
            }
        }

        if (epCount === 0) return []

        for (var i = 1; i <= epCount; i++) {
            var epPath = "/watch/" + id + "/ep-" + i
            episodes.push({
                id: epPath,
                number: i,
                url: this.baseUrl + epPath,
                title: "Episode " + i,
            })
        }

        return episodes
    }

    // ─── Find Episode Server ────────────────────────────────────────────
    async findEpisodeServer(
        episode: EpisodeDetails,
        server: string,
    ): Promise<EpisodeServer> {
        var result: EpisodeServer = {
            server: server,
            headers: { Referer: this.baseUrl },
            videoSources: [],
        }

        // Parse episode ID: /watch/{slug}/ep-{num}
        var epIdStr = episode.id || ""
        var epNumMatch = epIdStr.match(/ep-(\d+)$/)
        var epNum = epNumMatch ? epNumMatch[1] : "1"

        var slugMatch = epIdStr.match(/\/watch\/([^\/]+)/)
        var slug = slugMatch ? slugMatch[1] : ""

        var animeIdMatch = slug.match(/-(\d+)$/)
        var animeId = animeIdMatch ? animeIdMatch[1] : ""

        if (!animeId) return result

        // Map server name to sv-id
        var svId = "2" // DGHG default
        var serverLower = server.toLowerCase()
        if (serverLower.indexOf("byfms") !== -1) svId = "1"
        else if (serverLower.indexOf("vidplay") !== -1) svId = "4"
        else if (serverLower.indexOf("dghg") !== -1) svId = "2"

        try {
            // Step 1: Fetch server list to get data-link-id
            var serverListUrl = this.baseUrl + "/ajax/server/list?servers=" + animeId + "&eps=" + epNum
            var slRes = await fetch(serverListUrl)
            if (!slRes.ok) return result

            var slData: any
            try {
                slData = slRes.json()
            } catch (e) {
                return result
            }

            if (!slData || !slData.result) return result

            var $sl = LoadDoc(slData.result)
            var dataLinkId = ""

            // Find the matching server's data-link-id
            // Try sub type first
            $sl('li[data-sv-id="' + svId + '"]').each(function (_: number, el: DocSelection) {
                var lid = el.attr("data-link-id") || ""
                if (lid && !dataLinkId) {
                    dataLinkId = lid
                }
            })

            if (!dataLinkId) return result

            // Step 2: Fetch embed URL via ajax/sources
            var sourcesUrl = this.baseUrl + "/ajax/sources?id=" + encodeURIComponent(dataLinkId) + "&asi=0&autoPlay=0"
            var srcRes = await fetch(sourcesUrl)
            if (!srcRes.ok) return result

            var srcData: any
            try {
                srcData = srcRes.json()
            } catch (e) {
                return result
            }

            if (!srcData || srcData.status !== 200 || !srcData.result || !srcData.result.url) return result

            var embedUrl = srcData.result.url as string

            // Step 3: Fetch the embed page (DoodStream) to get pass_md5 URL
            var embedRes = await fetch(embedUrl, {
                headers: { Referer: this.baseUrl + "/" },
            })
            if (!embedRes.ok) return result

            var embedHtml = embedRes.text()

            // Extract the pass_md5 URL pattern from the embed page
            // Pattern in script: $.get('/pass_md5/{hash}/{token}', function(data) { ... })
            var passMatch = embedHtml.match(/\/pass_md5\/[a-zA-Z0-9\-]+\/[a-zA-Z0-9]+/)
            if (!passMatch) return result

            var passMd5Path = passMatch[0]

            // Extract the token (last segment of pass_md5 path)
            var pathParts = passMd5Path.split("/")
            var passToken = pathParts[pathParts.length - 1]

            // Determine the embed host for the pass_md5 request
            var embedHost = ""
            try {
                var embedParts = embedUrl.split("/")
                embedHost = embedParts[0] + "//" + embedParts[2]
            } catch (e) {
                embedHost = "https://playmogo.com"
            }

            // Step 4: Fetch pass_md5 to get CDN base URL
            var passMd5Url = embedHost + passMd5Path
            var passRes = await fetch(passMd5Url, {
                headers: { Referer: embedUrl },
            })
            if (!passRes.ok) return result

            var cdnBaseUrl = passRes.text().trim()
            if (!cdnBaseUrl || cdnBaseUrl.indexOf("http") !== 0) return result

            // Step 5: Construct final video URL
            // makePlay() generates: 10 random alphanumeric chars + ?token={token}&expiry={timestamp}
            var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
            var randomStr = ""
            for (var r = 0; r < 10; r++) {
                randomStr += chars.charAt(Math.floor(Math.random() * chars.length))
            }

            var expiry = Date.now()
            var videoUrl = cdnBaseUrl + randomStr + "?token=" + passToken + "&expiry=" + expiry

            result.videoSources.push({
                url: videoUrl,
                type: "mp4" as VideoSourceType,
                quality: "auto",
                subtitles: [],
            })

            // Set Referer to the embed host for CDN to accept the request
            result.headers = { Referer: embedHost + "/" }

        } catch (e) {
            // Silent fail — return empty result
        }

        return result
    }
}
