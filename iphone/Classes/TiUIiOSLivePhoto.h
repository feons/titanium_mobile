/**
 * Appcelerator Titanium Mobile
 * Copyright (c) 2009-2015 by Appcelerator, Inc. All Rights Reserved.
 * Licensed under the terms of the Apache Public License
 * Please see the LICENSE included with this distribution for details.
 */

#if IS_XCODE_7_1
#import "TiProxy.h"
#import <Photos/Photos.h>

@interface TiUIiOSLivePhoto : TiProxy

@property(nonatomic,retain) PHLivePhoto *livePhoto;

-(instancetype)initWithLivePhoto:(PHLivePhoto*)livePhoto;

@end
#endif