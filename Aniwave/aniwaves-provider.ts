/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />

/**
 * Seanime Online Streaming Provider for aniwaves.ru
 *
 * Endpoints used:
 *   AJAX Search:    GET /ajax/anime/search?keyword={query}
 *     Returns JSON: {status: 200, result: {html: "<div class='scaff items'><a class='item' href='/watch/{slug}'>..."}}
 *
 *   Watch page:     GET /watch/{slug}
 *     Raw HTML contains JSON-LD with episode counts and data-id attribute for anime ID.
 *     Episodes are NOT in raw HTML (loaded by JS), but episode count is in JSON-LD
 *     ("Subbed episodes released" / "Dubbed episodes released").
 *     URL pattern: /watch/{slug}/ep-{num}
 *
 *   AJAX Servers:   GET /ajax/server/list?servers={animeId}&eps={epNum}
 *     Returns JSON: {status: 200, result: "<div class='servers'>..."}
 *     Server sv-ids: Vidplay=4, BYFMS=1, DGHG=2
 *     data-link-id is encoded — requires ChromeDP to decode via the site's JS.
 */

class Provider {
    baseUrl = "https://aniwaves.ru"

    getSettings(): Settings {
        return {
            episodeServers: ["DGHG", "Vidplay", "BYFMS"],
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
            var jpTitle = nameEl.attr("data-jp") || ""

            if (!title || !href) return

            // Extract slug from href: /watch/naruto-76396
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
        // Fetch the watch page — episodes are loaded by JS but the raw HTML
        // contains JSON-LD structured data with the episode count, and the
        // data-id attribute with the numeric anime ID.
        var watchUrl = this.baseUrl + "/watch/" + id
        var res = await fetch(watchUrl)
        if (!res.ok) return []

        var html = res.text()
        var episodes: EpisodeDetails[] = []

        // Extract episode count from JSON-LD
        // Look for: "name": "Subbed episodes released", "value": N
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

        if (epCount === 0) {
            // Fallback: try to extract from the page using ChromeDP
            var browser = await ChromeDP.newBrowser()
            try {
                await browser.navigate(watchUrl)
                await browser.waitVisible(".ep-range li a")
                var countStr = await browser.evaluate(
                    "(function() { return document.querySelectorAll('.ep-range li a').length.toString(); })()"
                )
                epCount = parseInt(countStr as string, 10) || 0
            } catch (e) {
                // ignore
            } finally {
                await browser.close()
            }
        }

        // Generate episode list from count and URL pattern
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

        // Extract anime ID and episode number from the episode ID
        // Episode ID format: /watch/{slug}/ep-{num}
        // Slug format: {name}-{animeId} e.g. naruto-76396
        var epIdStr = episode.id || ""
        var epNumMatch = epIdStr.match(/ep-(\d+)$/)
        var epNum = epNumMatch ? epNumMatch[1] : "1"

        // Extract slug from episode ID
        var slugMatch = epIdStr.match(/\/watch\/([^\/]+)/)
        var slug = slugMatch ? slugMatch[1] : ""

        // Extract numeric anime ID from slug (last number after last hyphen)
        var animeIdMatch = slug.match(/-(\d+)$/)
        var animeId = animeIdMatch ? animeIdMatch[1] : ""

        if (!animeId) return result

        // Map server name to sv-id
        var serverLower = server.toLowerCase()
        var svId = "2" // default to DGHG (DoodStream) — most reliable
        if (serverLower.indexOf("byfms") !== -1) svId = "1"
        else if (serverLower.indexOf("vidplay") !== -1) svId = "4"
        else if (serverLower.indexOf("dghg") !== -1) svId = "2"

        // Determine sub or dub type
        var dataType = "sub"

        // Use ChromeDP to:
        // 1. Load the episode page and click the desired server
        // 2. Extract the iframe embed URL
        // 3. Navigate to the embed URL to extract the actual video source
        var browser = await ChromeDP.newBrowser()

        try {
            var pageUrl = episode.url || (this.baseUrl + epIdStr)
            await browser.navigate(pageUrl)

            // Wait for the servers section to load
            await browser.waitVisible(".servers .type li")

            // Click the desired server
            var clickSelector = '.servers .type[data-type="' + dataType + '"] li[data-sv-id="' + svId + '"]'
            await browser.click(clickSelector)

            // Wait for the iframe to appear
            await browser.sleep(3000)
            await browser.waitVisible("iframe")

            // Extract the iframe src (embed player URL)
            var iframeSrc = await browser.evaluate(
                "(function() { var f = document.querySelector('iframe'); return f ? f.src : ''; })()"
            )

            if (!iframeSrc || typeof iframeSrc !== "string" || iframeSrc.length === 0) {
                await browser.close()
                return result
            }

            // Step 2: Navigate to the embed URL to extract the actual video source
            // The embed player (DoodStream/playmogo, echovideo, etc.) loads a
            // video element with a direct CDN URL
            await browser.navigate(iframeSrc as string)
            await browser.sleep(5000)

            // Try to extract the video element source
            var videoSrc = await browser.evaluate(
                "(function() { var v = document.querySelector('video'); if (v) { return v.src || v.currentSrc || ''; } return ''; })()"
            )

            if (videoSrc && typeof videoSrc === "string" && videoSrc.length > 0) {
                // Direct video URL found (e.g. from DoodStream/DGHG)
                result.videoSources.push({
                    url: videoSrc as string,
                    type: "mp4" as VideoSourceType,
                    quality: "auto",
                    subtitles: [],
                })
                // Set Referer to the embed domain for the CDN to accept the request
                var embedUrl = iframeSrc as string
                try {
                    var embedHost = embedUrl.split("/")[2] || ""
                    if (embedHost) {
                        result.headers = { Referer: "https://" + embedHost + "/" }
                    }
                } catch (e2) {
                    // keep default referer
                }
            } else {
                // No video element — try to find m3u8 source in page scripts
                var hlsSrc = await browser.evaluate(
                    "(function() { " +
                    "var scripts = document.querySelectorAll('script'); " +
                    "for (var i = 0; i < scripts.length; i++) { " +
                    "  var t = scripts[i].textContent || ''; " +
                    "  var m = t.match(/[\"'](https?:\\/\\/[^\"']*\\.m3u8[^\"']*)[\"']/); " +
                    "  if (m) return m[1]; " +
                    "} " +
                    "return ''; " +
                    "})()"
                )

                if (hlsSrc && typeof hlsSrc === "string" && hlsSrc.length > 0) {
                    result.videoSources.push({
                        url: hlsSrc as string,
                        type: "m3u8" as VideoSourceType,
                        quality: "auto",
                        subtitles: [],
                    })
                } else {
                    // Last resort: check for any source element in video tag
                    var sourceSrc = await browser.evaluate(
                        "(function() { var s = document.querySelector('video source'); return s ? (s.src || '') : ''; })()"
                    )
                    if (sourceSrc && typeof sourceSrc === "string" && sourceSrc.length > 0) {
                        result.videoSources.push({
                            url: sourceSrc as string,
                            type: "mp4" as VideoSourceType,
                            quality: "auto",
                            subtitles: [],
                        })
                    }
                }
            }
        } catch (e) {
            console.error("ChromeDP error: " + e)
        } finally {
            await browser.close()
        }

        return result
    }
}
