"""
Builds a choropleth boundary file for the Haze Tracker's 5 NEA PSI/PM2.5
reporting regions (North/South/East/West/Central).

NEA does NOT publish polygon boundaries for these 5 regions -- only one
reference lat/lng per region (returned in the live API's region_metadata).
URA's official "Master Plan Region Boundary" is a DIFFERENT 5-region scheme
(Central/West/North/North-East/East -- note: no "South", has "North-East")
and must not be relabelled as NEA's regions.

So this script:
  1. Unions all URA Master Plan region polygons into one Singapore landmass
     outline (ignoring their internal region split -- used only as a
     coastline to clip against).
  2. Computes a Voronoi partition of the 5 NEA reference points (the exact
     lat/lng NEA's own API returns in region_metadata).
  3. Clips each Voronoi cell to the landmass outline.

Output is a disclosed approximation, not an NEA-published boundary -- the
frontend must label it as such.

data/sg_outline_raw.geojson is gitignored (1.4MB, regeneratable). To fetch it:
    curl -s "https://api-open.data.gov.sg/v1/public/api/datasets/d_bf4d24df9129d5a8ff8cf82e20959ee0/poll-download"
    # then curl the presigned "url" field from that response into data/sg_outline_raw.geojson
Dataset: "Master Plan 2019 Region Boundary (No Sea)" (URA, via data.gov.sg),
used here only for its coastline -- its own region split is unrelated to NEA's.
"""
import json
from shapely.geometry import shape, mapping, MultiPoint
from shapely.ops import voronoi_diagram, unary_union

RAW_PATH = "data/sg_outline_raw.geojson"
OUT_PATH = "data/psi_region_voronoi.geojson"

# Exact lat/lng as returned by NEA's own live API (region_metadata), not hand-entered guesses.
NEA_POINTS = {
    "north":   (1.41803, 103.82),
    "south":   (1.29587, 103.82),
    "east":    (1.35735, 103.94),
    "west":    (1.35735, 103.70),
    "central": (1.35735, 103.82),
}

def main():
    with open(RAW_PATH, encoding="utf-8") as f:
        raw = json.load(f)

    polys = [shape(feat["geometry"]) for feat in raw["features"]]
    landmass = unary_union(polys).buffer(0)
    landmass = landmass.simplify(0.0004, preserve_topology=True)
    print("landmass bounds:", landmass.bounds, "area:", landmass.area)

    names = list(NEA_POINTS.keys())
    pts = MultiPoint([(lng, lat) for (lat, lng) in NEA_POINTS.values()])

    vd = voronoi_diagram(pts, envelope=landmass.buffer(0.2))
    cells = list(vd.geoms)

    # Match each Voronoi cell back to its originating NEA point/region name.
    region_cells = {}
    for name, (lat, lng) in NEA_POINTS.items():
        from shapely.geometry import Point
        p = Point(lng, lat)
        best = min(cells, key=lambda c: c.distance(p))
        region_cells[name] = best

    features = []
    for name, cell in region_cells.items():
        clipped = cell.intersection(landmass).simplify(0.0002, preserve_topology=True)
        if clipped.is_empty:
            print(f"WARNING: empty clipped cell for {name}")
            continue
        features.append({
            "type": "Feature",
            "properties": {
                "region": name,
                "source_note": "Voronoi partition of NEA's own reference point for this region, clipped to URA landmass outline. NOT an NEA-published boundary."
            },
            "geometry": mapping(clipped)
        })

    out = {"type": "FeatureCollection", "features": features}
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"Wrote {OUT_PATH} with {len(features)} region polygons")

if __name__ == "__main__":
    main()
