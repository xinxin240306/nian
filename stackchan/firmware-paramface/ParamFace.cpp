// face.json parsing (cJSON) + expression delta merge + animation state machines.
#include "ParamFace.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <cJSON.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

namespace paramface {

const char* expressionKey(Expression e) {
    switch (e) {
        case Expression::Happy: return "happy";
        case Expression::Angry: return "angry";
        case Expression::Sad: return "sad";
        case Expression::Doubt: return "doubt";
        case Expression::Sleepy: return "sleepy";
        default: return nullptr;
    }
}

static float clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

static cJSON* objGet(const cJSON* o, const char* key) {
    return o ? cJSON_GetObjectItemCaseSensitive(const_cast<cJSON*>(o), key) : nullptr;
}

static float numOr(const cJSON* v, float dflt) {
    return cJSON_IsNumber(v) ? static_cast<float>(v->valuedouble) : dflt;
}

static float numPath(const cJSON* o, const char* a, const char* b, float dflt) {
    return numOr(objGet(objGet(o, a), b), dflt);
}

static int32_t colorOr(const cJSON* v, int32_t dflt) {
    if (!cJSON_IsString(v) || !v->valuestring) return dflt;
    const char* s = v->valuestring;
    if (s[0] != '#' || strlen(s) != 7) return dflt;
    char* end = nullptr;
    long val = strtol(s + 1, &end, 16);
    if (!end || *end != '\0') return dflt;
    return static_cast<int32_t>(val);
}

static int base64Decode(const char* s, uint8_t* out, int outCap) {
    static const char* kAlpha =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    int n = 0, bits = 0;
    uint32_t acc = 0;
    for (; *s && *s != '='; s++) {
        const char* p = strchr(kAlpha, *s);
        if (!p) return -1;
        acc = (acc << 6) | static_cast<uint32_t>(p - kAlpha);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (n >= outCap) return -1;
            out[n++] = static_cast<uint8_t>(acc >> bits);
        }
    }
    return n;
}

static void freeFrame(SpriteFrame* f) {
    free(f->pixels);
    *f = SpriteFrame();
}

static void freeSpriteSet(SpriteSet* s) {
    PartFrames* tables[] = {s->eyeL, s->eyeR, s->mouth, s->browL, s->browR};
    for (PartFrames* t : tables) {
        for (int i = 0; i < kExpressionCount; i++) {
            freeFrame(&t[i].f[0]);
            freeFrame(&t[i].f[1]);
        }
    }
    freeFrame(&s->overlay);
    for (int i = 0; i < kExpressionCount; i++) {
        freeFrame(&s->overlayExpr[i]);
        s->overlayMode[i] = OverlayMode::Inherit;
    }
}

static const char* parseSpriteFrame(const cJSON* o, SpriteFrame* out, int maxW = 48, int maxH = 48) {
    if (!cJSON_IsObject(o)) return nullptr;
    int w = cJSON_IsNumber(objGet(o, "w")) ? objGet(o, "w")->valueint : 0;
    int h = cJSON_IsNumber(objGet(o, "h")) ? objGet(o, "h")->valueint : 0;
    if (w < 1 || w > maxW || h < 1 || h > maxH) return "bad dims";
    cJSON* pal = objGet(o, "palette");
    if (!cJSON_IsArray(pal) || cJSON_GetArraySize(pal) > 15) return "bad palette";
    uint16_t palette565[15] = {0};
    int colors = 0;
    cJSON* item = nullptr;
    cJSON_ArrayForEach(item, pal) {
        int32_t rgb = colorOr(item, -1);
        if (rgb < 0) return "bad palette color";
        palette565[colors++] = static_cast<uint16_t>(
            ((rgb >> 8) & 0xF800) | ((rgb >> 5) & 0x07E0) | ((rgb >> 3) & 0x001F));
    }
    cJSON* dataV = objGet(o, "data");
    if (!cJSON_IsString(dataV) || !dataV->valuestring) return "missing data";
    const char* data = dataV->valuestring;
    int cap = static_cast<int>(strlen(data));
    uint8_t* rle = static_cast<uint8_t*>(malloc(cap ? cap : 1));
    if (!rle) return "oom";
    int nRle = base64Decode(data, rle, cap);
    if (nRle < 0) {
        free(rle);
        return "bad base64";
    }
    uint8_t* pixels = static_cast<uint8_t*>(malloc(w * h));
    if (!pixels) {
        free(rle);
        return "oom";
    }
    int n = 0;
    for (int i = 0; i < nRle; i++) {
        int run = (rle[i] >> 4) + 1, idx = rle[i] & 0x0F;
        if (idx > colors || n + run > w * h) {
            free(rle);
            free(pixels);
            return "bad rle";
        }
        memset(pixels + n, idx, run);
        n += run;
    }
    free(rle);
    if (n != w * h) {
        free(pixels);
        return "bad rle";
    }
    out->w = static_cast<uint16_t>(w);
    out->h = static_cast<uint16_t>(h);
    out->colors = static_cast<uint8_t>(colors);
    memcpy(out->palette565, palette565, sizeof(palette565));
    out->pixels = pixels;
    return nullptr;
}

static bool parseSprites(const cJSON* root, SpriteSet* s, char* err, int errCap) {
    struct Slot {
        const char* part;
        const char* frame;
        int fi;
        PartFrames* table;
    };
    const Slot slots[] = {
        {"eyeL", "open", 0, s->eyeL}, {"eyeL", "closed", 1, s->eyeL},
        {"eyeR", "open", 0, s->eyeR}, {"eyeR", "closed", 1, s->eyeR},
        {"mouth", "open", 0, s->mouth}, {"mouth", "closed", 1, s->mouth},
        {"browL", "open", 0, s->browL}, {"browR", "open", 0, s->browR},
    };
    cJSON* exprs = objGet(root, "expressions");
    for (int ei = 0; ei < kExpressionCount; ei++) {
        cJSON* parts = ei == 0
            ? objGet(root, "parts")
            : objGet(objGet(exprs, expressionKey(static_cast<Expression>(ei))), "parts");
        if (!cJSON_IsObject(parts)) continue;
        for (const Slot& sl : slots) {
            cJSON* frame = objGet(objGet(objGet(parts, sl.part), "frames"), sl.frame);
            const char* reason = parseSpriteFrame(frame, &sl.table[ei].f[sl.fi]);
            if (reason) {
                snprintf(err, errCap, "sprite %s%s%s/%s: %s",
                         ei ? expressionKey(static_cast<Expression>(ei)) : "",
                         ei ? "/" : "", sl.part, sl.frame, reason);
                return false;
            }
        }
    }

    float cw = clampf(numPath(root, "canvas", "width", 320), 16, 4096);
    float ch = clampf(numPath(root, "canvas", "height", 240), 16, 4096);
    auto expandSmooth = [cw, ch](SpriteFrame& f) {
        float psx = cw / f.w, psy = ch / f.h;
        float ps = psx < psy ? psx : psy;
        int passes = ps >= 4 ? 2 : (ps >= 2 ? 1 : 0);
        for (int i = 0; i < passes; i++) {
            uint8_t* big = static_cast<uint8_t*>(malloc(f.w * 2 * f.h * 2));
            if (!big) break;
            scale2xPass(f.pixels, f.w, f.h, big);
            free(f.pixels);
            f.pixels = big;
            f.w = static_cast<uint16_t>(f.w * 2);
            f.h = static_cast<uint16_t>(f.h * 2);
        }
    };

    cJSON* overlay = objGet(root, "overlay");
    bool smooth = cJSON_IsTrue(objGet(overlay, "smooth"));
    const char* reason = parseSpriteFrame(objGet(objGet(overlay, "frames"), "open"), &s->overlay, 80, 60);
    if (reason) {
        snprintf(err, errCap, "sprite overlay: %s", reason);
        return false;
    }
    if (s->overlay.present() && smooth) expandSmooth(s->overlay);

    cJSON* exprTable = objGet(overlay, "expr");
    for (int i = 1; i < kExpressionCount; i++) {
        cJSON* e = objGet(exprTable, expressionKey(static_cast<Expression>(i)));
        if (!cJSON_IsObject(e)) continue;
        if (cJSON_IsTrue(objGet(e, "hidden"))) {
            s->overlayMode[i] = OverlayMode::Hidden;
            continue;
        }
        reason = parseSpriteFrame(objGet(objGet(e, "frames"), "open"), &s->overlayExpr[i], 80, 60);
        if (reason) {
            snprintf(err, errCap, "sprite overlay/%s: %s",
                     expressionKey(static_cast<Expression>(i)), reason);
            return false;
        }
        if (s->overlayExpr[i].present()) {
            s->overlayMode[i] = OverlayMode::Own;
            if (smooth) expandSmooth(s->overlayExpr[i]);
        }
    }
    return true;
}

static void parseLid(const cJSON* o, Lid* lid) {
    lid->angle = clampf(numOr(objGet(o, "angle"), lid->angle), -90, 90);
    lid->cover = clampf(numOr(objGet(o, "cover"), lid->cover), 0, 1);
}

static void parseEye(const cJSON* o, EyeParams* p) {
    if (!cJSON_IsObject(o)) {
        p->present = false;
        return;
    }
    p->present = true;
    p->x = numPath(o, "pos", "x", p->x);
    p->y = numPath(o, "pos", "y", p->y);
    cJSON* shape = objGet(o, "shape");
    if (cJSON_IsString(shape) && shape->valuestring) {
        if (!strcmp(shape->valuestring, "roundRect")) p->shape = EyeShape::RoundRect;
        else if (!strcmp(shape->valuestring, "arc")) p->shape = EyeShape::Arc;
        else if (!strcmp(shape->valuestring, "pixel")) p->shape = EyeShape::Pixel;
        else p->shape = EyeShape::Ellipse;
    }
    p->spriteScale = clampf(numOr(objGet(o, "scale"), p->spriteScale), 1, 8);
    if (cJSON_IsBool(objGet(o, "smooth"))) p->smooth = cJSON_IsTrue(objGet(o, "smooth"));
    p->width = clampf(numOr(objGet(o, "width"), p->width), 1, 640);
    p->height = clampf(numOr(objGet(o, "height"), p->height), 1, 480);
    p->cornerRadius = clampf(numOr(objGet(o, "cornerRadius"), p->cornerRadius), 0, 240);
    p->curve = clampf(numOr(objGet(o, "curve"), p->curve), -1, 1);
    p->thickness = clampf(numOr(objGet(o, "thickness"), p->thickness), 1, 32);
    parseLid(objGet(o, "upperLid"), &p->upperLid);
    parseLid(objGet(o, "lowerLid"), &p->lowerLid);
    if (cJSON_IsBool(objGet(o, "highlight"))) p->highlight = cJSON_IsTrue(objGet(o, "highlight"));
    p->color = colorOr(objGet(o, "color"), p->color);
}

static void parseBrow(const cJSON* o, BrowParams* p) {
    if (!cJSON_IsObject(o)) {
        p->present = false;
        return;
    }
    p->present = true;
    p->x = numPath(o, "pos", "x", p->x);
    p->y = numPath(o, "pos", "y", p->y);
    cJSON* shape = objGet(o, "shape");
    if (cJSON_IsString(shape) && shape->valuestring) {
        if (!strcmp(shape->valuestring, "arc")) p->shape = BrowShape::Arc;
        else if (!strcmp(shape->valuestring, "pixel")) p->shape = BrowShape::Pixel;
        else p->shape = BrowShape::Rect;
    }
    p->spriteScale = clampf(numOr(objGet(o, "scale"), p->spriteScale), 1, 8);
    if (cJSON_IsBool(objGet(o, "smooth"))) p->smooth = cJSON_IsTrue(objGet(o, "smooth"));
    p->width = clampf(numOr(objGet(o, "width"), p->width), 0, 640);
    p->thickness = clampf(numOr(objGet(o, "thickness"), p->thickness), 1, 60);
    p->angle = clampf(numOr(objGet(o, "angle"), p->angle), -90, 90);
    p->curve = clampf(numOr(objGet(o, "curve"), p->curve), -1, 1);
    p->color = colorOr(objGet(o, "color"), p->color);
}

static void parseMouth(const cJSON* o, MouthParams* p) {
    if (!cJSON_IsObject(o)) {
        p->present = false;
        return;
    }
    p->present = true;
    p->x = numPath(o, "pos", "x", p->x);
    p->y = numPath(o, "pos", "y", p->y);
    cJSON* shape = objGet(o, "shape");
    if (cJSON_IsString(shape) && shape->valuestring) {
        if (!strcmp(shape->valuestring, "arc")) p->shape = MouthShape::Arc;
        else if (!strcmp(shape->valuestring, "omega")) p->shape = MouthShape::Omega;
        else if (!strcmp(shape->valuestring, "pixel")) p->shape = MouthShape::Pixel;
        else p->shape = MouthShape::Rect;
    }
    p->spriteScale = clampf(numOr(objGet(o, "scale"), p->spriteScale), 1, 8);
    if (cJSON_IsBool(objGet(o, "smooth"))) p->smooth = cJSON_IsTrue(objGet(o, "smooth"));
    p->minWidth = clampf(numOr(objGet(o, "minWidth"), p->minWidth), 0, 640);
    p->maxWidth = clampf(numOr(objGet(o, "maxWidth"), p->maxWidth), 0, 640);
    p->minHeight = clampf(numOr(objGet(o, "minHeight"), p->minHeight), 0, 480);
    p->maxHeight = clampf(numOr(objGet(o, "maxHeight"), p->maxHeight), 0, 480);
    p->curve = clampf(numOr(objGet(o, "curve"), p->curve), -1, 1);
    p->color = colorOr(objGet(o, "color"), p->color);
}

static void parseFace(const cJSON* root, FaceParams* f) {
    f->canvasW = clampf(numPath(root, "canvas", "width", 320), 16, 4096);
    f->canvasH = clampf(numPath(root, "canvas", "height", 240), 16, 4096);
    cJSON* pal = objGet(root, "palette");
    f->palette.primary = colorOr(objGet(pal, "primary"), f->palette.primary);
    f->palette.secondary = colorOr(objGet(pal, "secondary"), f->palette.secondary);
    f->palette.background = colorOr(objGet(pal, "background"), f->palette.background);
    cJSON* parts = objGet(root, "parts");
    parseEye(objGet(parts, "eyeL"), &f->eyeL);
    parseEye(objGet(parts, "eyeR"), &f->eyeR);
    parseBrow(objGet(parts, "browL"), &f->browL);
    parseBrow(objGet(parts, "browR"), &f->browR);
    parseMouth(objGet(parts, "mouth"), &f->mouth);
    cJSON* anim = objGet(root, "animation");
    f->anim.blinkInterval = clampf(numPath(anim, "blink", "interval", f->anim.blinkInterval), 0.3f, 60);
    f->anim.blinkDuration = clampf(numPath(anim, "blink", "duration", f->anim.blinkDuration), 30, 2000);
    f->anim.saccadeInterval = clampf(numPath(anim, "saccade", "interval", f->anim.saccadeInterval), 0.3f, 60);
    f->anim.saccadeAmplitude = clampf(numPath(anim, "saccade", "amplitude", f->anim.saccadeAmplitude), 0, 1);
    f->anim.breathPeriod = clampf(numPath(anim, "breath", "period", f->anim.breathPeriod), 0.5f, 60);
    f->anim.breathDepth = clampf(numPath(anim, "breath", "depth", f->anim.breathDepth), 0, 1);
}

static void mergeDelta(cJSON* dst, const cJSON* delta) {
    if (!cJSON_IsObject(dst) || !cJSON_IsObject(delta)) return;
    for (cJSON* kv = delta->child; kv; kv = kv->next) {
        const char* key = kv->string;
        if (!key) continue;
        cJSON* existing = cJSON_GetObjectItemCaseSensitive(dst, key);
        if (cJSON_IsObject(kv) && !cJSON_IsArray(kv)) {
            if (!cJSON_IsObject(existing)) {
                cJSON_DeleteItemFromObjectCaseSensitive(dst, key);
                cJSON* child = cJSON_CreateObject();
                cJSON_AddItemToObject(dst, key, child);
                mergeDelta(child, kv);
            } else {
                mergeDelta(existing, kv);
            }
        } else if (cJSON_IsNumber(kv) && cJSON_IsNumber(existing)) {
            cJSON_SetNumberValue(existing, existing->valuedouble + kv->valuedouble);
        } else {
            cJSON_DeleteItemFromObjectCaseSensitive(dst, key);
            cJSON_AddItemToObject(dst, key, cJSON_Duplicate(kv, 1));
        }
    }
}

bool ParamFace::load(const char* json) {
    cJSON* root = cJSON_Parse(json);
    if (!root || !cJSON_IsObject(root)) {
        snprintf(error_, sizeof(error_), "json: %s", root ? "root is not an object" : "parse failed");
        cJSON_Delete(root);
        return false;
    }

    SpriteSet* stagedSprites = new SpriteSet();
    if (!parseSprites(root, stagedSprites, error_, sizeof(error_))) {
        freeSpriteSet(stagedSprites);
        delete stagedSprites;
        cJSON_Delete(root);
        return false;
    }

    FaceParams staged[kExpressionCount];
    parseFace(root, &staged[0]);

    cJSON* exprs = objGet(root, "expressions");
    for (int i = 1; i < kExpressionCount; i++) {
        const char* key = expressionKey(static_cast<Expression>(i));
        cJSON* delta = objGet(exprs, key);
        if (!cJSON_IsObject(delta)) {
            staged[i] = staged[0];
            continue;
        }
        cJSON* merged = cJSON_Duplicate(root, 1);
        mergeDelta(merged, delta);
        staged[i] = FaceParams();
        parseFace(merged, &staged[i]);
        cJSON_Delete(merged);
    }

    for (int i = 0; i < kExpressionCount; i++) faces_[i] = staged[i];
    freeSpriteSet(&sprites_);
    sprites_ = *stagedSprites;
    delete stagedSprites;
    if (!loaded_) animator_.reset();
    loaded_ = true;
    error_[0] = '\0';
    cJSON_Delete(root);
    return true;
}

ParamFace::~ParamFace() { freeSpriteSet(&sprites_); }

void ParamFace::tick(float dtMs) {
    if (!loaded_) return;
    animator_.tick(dtMs, effective().anim, &driven_);
    if (mouthOverride_) driven_.mouthOpen = clampf(mouthOverrideV_, 0, 1);
    if (gazeOverride_) {
        driven_.gazeH = clampf(gazeOverrideH_, -1, 1);
        driven_.gazeV = clampf(gazeOverrideV_, -1, 1);
    }
}

void Animator::reset(uint32_t seed) {
    rng_ = seed ? seed : 1;
    tMs_ = 0;
    nextBlinkMs_ = 800;
    blinkPhaseMs_ = -1;
    nextSaccadeMs_ = 400;
    gazeTargetH_ = gazeTargetV_ = gazeH_ = gazeV_ = 0;
}

float Animator::rand01() {
    rng_ = rng_ * 1664525u + 1013904223u;
    return (rng_ >> 8) * (1.0f / 16777216.0f);
}

void Animator::tick(float dtMs, const AnimParams& p, DrivenState* out) {
    if (dtMs < 0) dtMs = 0;
    if (dtMs > 200) dtMs = 200;
    tMs_ += dtMs;

    float open = 1;
    if (blinkPhaseMs_ >= 0) {
        blinkPhaseMs_ += dtMs;
        float half = p.blinkDuration * 0.5f;
        if (blinkPhaseMs_ >= p.blinkDuration) {
            blinkPhaseMs_ = -1;
        } else if (blinkPhaseMs_ < half) {
            open = 1 - blinkPhaseMs_ / half;
        } else {
            open = (blinkPhaseMs_ - half) / half;
        }
    } else if (tMs_ >= nextBlinkMs_) {
        blinkPhaseMs_ = 0;
        open = 1;
        nextBlinkMs_ = tMs_ + p.blinkInterval * 1000.0f * (0.6f + 0.8f * rand01());
    }
    out->eyeOpenL = out->eyeOpenR = open;

    if (tMs_ >= nextSaccadeMs_) {
        if (rand01() < 0.35f) {
            gazeTargetH_ = gazeTargetV_ = 0;
        } else {
            gazeTargetH_ = (rand01() * 2 - 1) * p.saccadeAmplitude;
            gazeTargetV_ = (rand01() * 2 - 1) * p.saccadeAmplitude * 0.6f;
        }
        nextSaccadeMs_ = tMs_ + p.saccadeInterval * 1000.0f * (0.5f + rand01());
    }
    float k = 1 - expf(-dtMs / 60.0f);
    gazeH_ += (gazeTargetH_ - gazeH_) * k;
    gazeV_ += (gazeTargetV_ - gazeV_) * k;
    out->gazeH = gazeH_;
    out->gazeV = gazeV_;

    out->breath =
        (0.5f + 0.5f * sinf(tMs_ * 2.0f * static_cast<float>(M_PI) / (p.breathPeriod * 1000.0f))) *
        p.breathDepth;
    out->mouthOpen = 0;
}

}  // namespace paramface
