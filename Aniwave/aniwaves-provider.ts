/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />

/**
 * Seanime Online Streaming Provider for aniwaves.ru
 *
 * This extension scrapes aniwaves.ru (an aniwave/9anime-style site)
 * to provide anime search, episode listing, and video source extraction.
 *
 * Site structure (aniwave pattern):
 *   Search:     GET /filter?keyword={query}
 *   Anime page: GET /watch/{slug}
 *   Episodes:   GET /ajax/episode/list/{anime-data-id}
 *   Servers:    GET /ajax/server/list/{episode-data-id}
 *   Sources:    GET /ajax/sources/{server-data-id}
 */

class Provider {
    baseUrl = "https://aniwaves.ru"
    headers = {
        "Referer": "https://aniwaves.ru/",
        "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
    }

    getSettings(): Settings {
        return {
            episodeServers: ["vidplay", "mycloud", "filemoon", "mp4upload"],
            supportsDub: true,
        }
    }

    // ─── Search ─────────────────────────────────────────────────────────
    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const query = opts.query || opts.media.englishTitle || opts.media.romajiTitle || ""
        if (!query) return []

        const url = `${this.baseUrl}/filter?keyword=${encodeURIComponent(query)}`
        const res = await fetch(url, { headers: this.headers })
        if (!res.ok) return []

        const html = await res.text()
        const $ = LoadDoc(html)
        const results: SearchResult[] = []

        // Aniwave sites use .flw-item for each anime card
        $(".flw-item").each((_: number, el: any) => {
            const anchor = $(el).find(".film-name a, .dynamic-name, h3 a, h2 a")
            const title = anchor.text().trim()
            const href = anchor.attr("href") || ""

            if (!title || !href) return

            // Extract the slug/ID from the href (e.g. /watch/one-piece-81553)
            const id = href.replace(/^\/watch\//, "").replace(/^\//, "")

            // Detect sub/dub from tick items or labels
            const tickItems = $(el).find(".tick-item, .tick").text().toLowerCase()
            let subOrDub: SubOrDub = "sub"
            if (tickItems.includes("dub") && tickItems.includes("sub")) {
                subOrDub = "both"
            } else if (tickItems.includes("dub")) {
                subOrDub = "dub"
            }

            results.push({
                id: id,
                title: title,
                url: `${this.baseUrl}/watch/${id}`,
                subOrDub: subOrDub,
            })
        })

        // Fallback: try alternative card selectors if .flw-item didn't match
        if (results.length === 0) {
            $(".anime-list .item, .film_list-wrap .flw-item, .film-list .item, .list-item, .anime-block a").each(
                (_: number, el: any) => {
                    const anchor = $(el).find("a[href*='/watch/']").length
                        ? $(el).find("a[href*='/watch/']")
                        : $(el)
                    const title =
                        anchor.attr("title") ||
                        $(el).find(".film-name, .name, .title, h3, h2").text().trim() ||
                        anchor.text().trim()
                    const href = anchor.attr("href") || ""

                    if (!title || !href || !href.includes("/watch/")) return

                    const id = href.split("/watch/").pop() || ""
                    if (!id) return

                    results.push({
                        id: id,
                        title: title,
                        url: `${this.baseUrl}/watch/${id}`,
                        subOrDub: "sub" as SubOrDub,
                    })
                },
            )
        }

        return results
    }

    // ─── Find Episodes ──────────────────────────────────────────────────
    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        // Step 1: Load the anime detail page to get the data-id
        const watchUrl = `${this.baseUrl}/watch/${id}`
        const pageRes = await fetch(watchUrl, { headers: this.headers })
        if (!pageRes.ok) return []

        const pageHtml = await pageRes.text()
        const $page = LoadDoc(pageHtml)

        // The anime detail page has a data-id attribute on the episode list container
        // Common selectors: #watch-main[data-id], .watch-section[data-id], [data-id]
        let dataId =
            $page("#watch-main").attr("data-id") ||
            $page(".watch-main").attr("data-id") ||
            $page("[data-id]").first().attr("data-id") ||
            ""

        // Alternative: try to extract from a script or data attribute
        if (!dataId) {
            const bodyHtml = pageHtml
            const dataIdMatch = bodyHtml.match(/data-id="(\d+)"/)
            if (dataIdMatch) {
                dataId = dataIdMatch[1]
            }
        }

        if (!dataId) {
            console.warn("Could not find data-id for anime: " + id)
            return []
        }

        // Step 2: Fetch episodes via AJAX endpoint
        const ajaxUrl = `${this.baseUrl}/ajax/episode/list/${dataId}`
        const ajaxRes = await fetch(ajaxUrl, {
            headers: {
                ...this.headers,
                "X-Requested-With": "XMLHttpRequest",
            },
        })
        if (!ajaxRes.ok) return []

        // The AJAX endpoint returns JSON with an "html" field, or raw HTML
        let episodeHtml = ""
        const contentType = ajaxRes.headers.get("content-type") || ""

        if (contentType.includes("json")) {
            const jsonData = (await ajaxRes.json()) as { html?: string; result?: string }
            episodeHtml = jsonData.html || jsonData.result || ""
        } else {
            episodeHtml = await ajaxRes.text()
        }

        if (!episodeHtml) return []

        const $ep = LoadDoc(episodeHtml)
        const episodes: EpisodeDetails[] = []

        // Episodes are typically listed as <a> or <li> elements with data-ids
        $ep("a[data-id], .ep-item, .ssl-item").each((_: number, el: any) => {
            const epDataId = $(el).attr("data-id") || $(el).attr("data-ids") || ""
            const epNum =
                $(el).attr("data-number") ||
                $(el).attr("data-num") ||
                $(el).find(".ssli-order, .ep-num").text().trim() ||
                $(el).attr("data-ep") ||
                ""
            const epTitle =
                $(el).attr("title") ||
                $(el).find(".ep-name, .ssli-detail .ep-name").text().trim() ||
                ""

            const num = parseInt(epNum, 10)
            if (!epDataId || isNaN(num)) return

            episodes.push({
                id: epDataId,
                number: num,
                url: `${watchUrl}?ep=${epDataId}`,
                title: epTitle || `Episode ${num}`,
            })
        })

        // Fallback: try alternative selectors
        if (episodes.length === 0) {
            $ep("li[data-id], .episode-item, [data-ep-id]").each((_: number, el: any) => {
                const epDataId =
                    $(el).attr("data-id") || $(el).attr("data-ep-id") || ""
                const epNumText =
                    $(el).attr("data-number") ||
                    $(el).text().trim().match(/\d+/)?.[0] ||
                    ""
                const num = parseInt(epNumText, 10)

                if (!epDataId || isNaN(num)) return

                episodes.push({
                    id: epDataId,
                    number: num,
                    url: `${watchUrl}?ep=${epDataId}`,
                    title: `Episode ${num}`,
                })
            })
        }

        // Sort by episode number
        episodes.sort((a, b) => a.number - b.number)
        return episodes
    }

    // ─── Find Episode Server ────────────────────────────────────────────
    async findEpisodeServer(
        episode: EpisodeDetails,
        server: string,
    ): Promise<EpisodeServer> {
        const result: EpisodeServer = {
            server: server,
            headers: { Referer: this.baseUrl },
            videoSources: [],
        }

        // Step 1: Fetch the server list for this episode
        const serverListUrl = `${this.baseUrl}/ajax/server/list/${episode.id}`
        const serverRes = await fetch(serverListUrl, {
            headers: {
                ...this.headers,
                "X-Requested-With": "XMLHttpRequest",
            },
        })

        if (!serverRes.ok) return result

        let serverHtml = ""
        const sContentType = serverRes.headers.get("content-type") || ""

        if (sContentType.includes("json")) {
            const jsonData = (await serverRes.json()) as { html?: string; result?: string }
            serverHtml = jsonData.html || jsonData.result || ""
        } else {
            serverHtml = await serverRes.text()
        }

        if (!serverHtml) return result

        const $srv = LoadDoc(serverHtml)

        // Find the matching server by name
        // Servers are typically listed with data-id attributes
        let serverDataId = ""

        // Check both sub and dub server sections
        $srv(".server-item, [data-server-id], li[data-id]").each(
            (_: number, el: any) => {
                const srvName = (
                    $(el).attr("data-server-name") ||
                    $(el).find("a").text().trim() ||
                    $(el).text().trim()
                ).toLowerCase()
                const srvId =
                    $(el).attr("data-id") ||
                    $(el).attr("data-server-id") ||
                    $(el).find("a").attr("data-id") ||
                    ""

                if (srvName.includes(server.toLowerCase()) && srvId) {
                    serverDataId = srvId
                }
            },
        )

        // If exact match not found, use the first available server
        if (!serverDataId) {
            const firstServer = $srv(
                ".server-item[data-id], [data-server-id], li[data-id]",
            ).first()
            serverDataId =
                firstServer.attr("data-id") ||
                firstServer.attr("data-server-id") ||
                ""
        }

        if (!serverDataId) {
            console.warn("No server found for episode: " + episode.id)
            return result
        }

        // Step 2: Fetch the video source for this server
        const sourceUrl = `${this.baseUrl}/ajax/sources/${serverDataId}`
        const sourceRes = await fetch(sourceUrl, {
            headers: {
                ...this.headers,
                "X-Requested-With": "XMLHttpRequest",
            },
        })

        if (!sourceRes.ok) return result

        const sourceData = (await sourceRes.json()) as {
            link?: string
            result?: { url?: string; link?: string }
            type?: string
            server?: number
            tracks?: Array<{ file: string; label: string; kind: string; default?: boolean }>
        }

        const embedUrl =
            sourceData.link ||
            sourceData.result?.url ||
            sourceData.result?.link ||
            ""

        if (!embedUrl) return result

        // Step 3: Try to extract the actual video URL from the embed
        // The embed URL typically points to vidplay, megacloud, filemoon, etc.
        const videoSources = await this.extractVideoSources(embedUrl)

        // Add subtitles from tracks if available
        const subtitles: VideoSubtitle[] = []
        if (sourceData.tracks) {
            sourceData.tracks.forEach(
                (track: { file: string; label: string; kind: string; default?: boolean }, idx: number) => {
                    if (track.kind === "captions" || track.kind === "subtitles") {
                        subtitles.push({
                            id: `sub-${idx}`,
                            url: track.file,
                            language: track.label || "Unknown",
                            isDefault: track.default || false,
                        })
                    }
                },
            )
        }

        if (videoSources.length > 0) {
            result.videoSources = videoSources.map((vs) => ({
                ...vs,
                subtitles: subtitles.length > 0 ? subtitles : vs.subtitles,
            }))
        } else {
            // Fallback: return the embed URL as the source
            // Seanime may be able to handle embed URLs directly
            result.videoSources = [
                {
                    url: embedUrl,
                    type: "m3u8" as VideoSourceType,
                    quality: "auto",
                    subtitles: subtitles,
                },
            ]
        }

        return result
    }

    // ─── Helper: Extract video sources from an embed URL ────────────────
    private async extractVideoSources(embedUrl: string): Promise<VideoSource[]> {
        const sources: VideoSource[] = []

        try {
            const res = await fetch(embedUrl, {
                headers: {
                    Referer: this.baseUrl,
                    "User-Agent": this.headers["User-Agent"],
                },
            })

            if (!res.ok) return sources

            const html = await res.text()

            // Look for m3u8 or mp4 URLs in the embed page source
            // Pattern 1: Direct m3u8 URLs
            const m3u8Matches = html.match(
                /https?:\/\/[^\s"'\\]+\.m3u8[^\s"'\\]*/g,
            )
            if (m3u8Matches) {
                m3u8Matches.forEach((url: string, idx: number) => {
                    sources.push({
                        url: url,
                        type: "m3u8" as VideoSourceType,
                        quality: idx === 0 ? "auto" : `source-${idx}`,
                        subtitles: [],
                    })
                })
            }

            // Pattern 2: Direct mp4 URLs
            const mp4Matches = html.match(
                /https?:\/\/[^\s"'\\]+\.mp4[^\s"'\\]*/g,
            )
            if (mp4Matches) {
                mp4Matches.forEach((url: string, idx: number) => {
                    sources.push({
                        url: url,
                        type: "mp4" as VideoSourceType,
                        quality: idx === 0 ? "720p" : `source-${idx}`,
                        subtitles: [],
                    })
                })
            }

            // Pattern 3: JSON-encoded source objects
            const jsonSourceMatch = html.match(
                /sources\s*[:=]\s*(\[[\s\S]*?\])/,
            )
            if (jsonSourceMatch) {
                try {
                    const parsed = JSON.parse(jsonSourceMatch[1]) as Array<{
                        file?: string
                        src?: string
                        url?: string
                        type?: string
                        label?: string
                        quality?: string
                    }>
                    parsed.forEach((s) => {
                        const fileUrl = s.file || s.src || s.url || ""
                        if (!fileUrl) return

                        let type: VideoSourceType = "unknown"
                        if (fileUrl.includes(".m3u8")) type = "m3u8"
                        else if (fileUrl.includes(".mp4")) type = "mp4"

                        sources.push({
                            url: fileUrl,
                            type: type,
                            quality: s.label || s.quality || "auto",
                            subtitles: [],
                        })
                    })
                } catch (_e) {
                    // JSON parse failed, continue
                }
            }

            // Pattern 4: Look for file/source in script tags
            const fileMatch = html.match(/file\s*[:=]\s*["']([^"']+)["']/)
            if (fileMatch && sources.length === 0) {
                let type: VideoSourceType = "unknown"
                if (fileMatch[1].includes(".m3u8")) type = "m3u8"
                else if (fileMatch[1].includes(".mp4")) type = "mp4"

                sources.push({
                    url: fileMatch[1],
                    type: type,
                    quality: "auto",
                    subtitles: [],
                })
            }
        } catch (e) {
            console.error("Failed to extract video sources from embed: " + e)
        }

        return sources
    }
}
