/// <reference path="./online-streaming-provider.d.ts" />
/// <reference path="./core.d.ts" />

/**
 * Seanime Online Streaming Provider for aniwaves.ru
 *
 * Site structure:
 *   Search page:  /filter?keyword={query}
 *     Items:      div.item > div.inner > div.ani.poster[data-tip="{id}"]
 *                   > a[href="/watch/{slug}"] with img
 *                 div.info > a.name.d-title[href][data-jp]
 *                 span.ep-status.sub / span.ep-status.dub for sub/dub counts
 *
 *   Watch page:   /watch/{slug}  (redirects to /watch/{slug}/ep-1)
 *     Data ID:    div.layout-page-watchtv[data-id="{animeId}"]
 *     Episodes:   ul.ep-range > li > a[data-num][data-ids][data-sub][data-dub][href]
 *     Servers:    div.servers > div.type[data-type="sub"|"dub"]
 *                   > li[data-sv-id][data-link-id][data-ep-id]
 *                 Server names: Vidplay (sv-id=4), BYFMS (sv-id=1), DGHG (sv-id=2)
 *
 *   Video source: data-link-id is encoded/compressed. The site's JS decodes it
 *                 and loads an iframe pointing to an embed player
 *                 (e.g. play.echovideo.ru, weneverbeenfree.com).
 *                 We use ChromeDP to render the page and extract the iframe src.
 */

class Provider {
    baseUrl = "https://aniwaves.ru"

    getSettings(): Settings {
        return {
            episodeServers: ["Vidplay", "BYFMS", "DGHG"],
            supportsDub: true,
        }
    }

    // ─── Search ─────────────────────────────────────────────────────────
    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const query = opts.query || opts.media.englishTitle || opts.media.romajiTitle || ""
        if (!query) return []

        const url = `${this.baseUrl}/filter?keyword=${encodeURIComponent(query)}`
        const res = await fetch(url)
        if (!res.ok) return []

        const html = res.text()
        const $ = LoadDoc(html)
        const results: SearchResult[] = []

        $(".item").each((_: number, el: DocSelection) => {
            // Title and link
            const nameLink = el.find("a.name.d-title")
            const title = nameLink.text().trim()
            const href = nameLink.attr("href") || ""

            if (!title || !href) return

            // Extract slug from href: /watch/naruto-76396
            const slug = href.replace(/^\/watch\//, "")
            if (!slug) return

            // Detect sub/dub from ep-status spans
            const subText = el.find(".ep-status.sub span").text().trim()
            const dubText = el.find(".ep-status.dub span").text().trim()

            let subOrDub: SubOrDub = "sub"
            if (subText && dubText) {
                subOrDub = "both"
            } else if (dubText && !subText) {
                subOrDub = "dub"
            }

            results.push({
                id: slug,
                title: title,
                url: `${this.baseUrl}/watch/${slug}`,
                subOrDub: subOrDub,
            })
        })

        return results
    }

    // ─── Find Episodes ──────────────────────────────────────────────────
    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        // Load the watch page — episodes are rendered inline in the HTML
        const watchUrl = `${this.baseUrl}/watch/${id}`
        const res = await fetch(watchUrl)
        if (!res.ok) return []

        const html = res.text()
        const $ = LoadDoc(html)
        const episodes: EpisodeDetails[] = []

        // Episodes: ul.ep-range > li > a[data-num][href]
        $(".ep-range li a").each((_: number, el: DocSelection) => {
            const numStr = el.attr("data-num") || "0"
            const num = parseInt(numStr, 10)
            const href = el.attr("href") || ""
            const title = el.parent().attr("title") || ""

            if (isNaN(num) || num === 0) return

            // Use the full path as the episode ID
            const epPath = href.startsWith("/") ? href : `/watch/${id}/ep-${num}`

            episodes.push({
                id: epPath,
                number: num,
                url: `${this.baseUrl}${epPath}`,
                title: title || `Episode ${num}`,
            })
        })

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

        // The data-link-id is encoded/compressed and requires the site's own JS to
        // decode it into an embed URL. We use ChromeDP to load the page in a headless
        // browser, click the desired server, and read the resulting iframe src.
        const browser = await ChromeDP.newBrowser()

        try {
            // Navigate to the episode page
            const pageUrl = episode.url || `${this.baseUrl}${episode.id}`
            await browser.navigate(pageUrl)

            // Wait for the servers section to load
            await browser.waitVisible(".servers .type li")

            // Map server name to sv-id
            const serverLower = server.toLowerCase()
            let svId = "4" // default to Vidplay
            if (serverLower.includes("byfms")) svId = "1"
            else if (serverLower.includes("dghg")) svId = "2"
            else if (serverLower.includes("vidplay")) svId = "4"

            // Click the server button (sub type)
            const clickSelector = `.servers .type[data-type="sub"] li[data-sv-id="${svId}"]`
            await browser.click(clickSelector)

            // Wait for the iframe to appear
            await browser.sleep(2000)
            await browser.waitVisible("iframe")

            // Extract the iframe src
            const iframeSrc = await browser.evaluate(
                `(function() { var f = document.querySelector('iframe'); return f ? f.src : ''; })()`
            )

            if (iframeSrc && typeof iframeSrc === "string" && iframeSrc.length > 0) {
                result.videoSources.push({
                    url: iframeSrc,
                    type: "m3u8" as VideoSourceType,
                    quality: "auto",
                    subtitles: [],
                })
            }
        } catch (e) {
            console.error("ChromeDP error: " + e)
        } finally {
            await browser.close()
        }

        return result
    }
}
